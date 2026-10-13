// Abyss API: stores each visitor's dives, tasks and discoveries in MongoDB, keyed by a private "dive key".
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { nanoid } from 'nanoid';
import { hashPassword, verifyPassword, signToken, requireAuth, tooMany } from './auth.js';

const PORT = process.env.PORT || 5060;
if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI in server/.env'); process.exit(1); }
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'abyss');
const users = db.collection('users'), dives = db.collection('dives'), profiles = db.collection('profiles');
await users.createIndex({ email: 1 }, { unique: true });
await dives.createIndex({ uid: 1, ts: 1 }, { unique: true });
await profiles.createIndex({ uid: 1 }, { unique: true });

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || '*').split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '300kb' }));

// Rate limit every API call per IP.
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now(), list = (hits.get(req.ip) || []).filter(t => now - t < 60000); list.push(now); hits.set(req.ip, list);
  return list.length > 120 ? res.status(429).json({ error: 'Slow down for a moment.' }) : next();
});

// ---- Authentication: email + password, scrypt hashing, signed JWT ----
const publicUser = u => ({ id: u.id, name: u.name, email: u.email });
app.post('/api/auth/register', async (req, res, next) => {
  try {
    if (tooMany(`reg:${req.ip}`, 8)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    const name = String(req.body.name || '').trim().slice(0, 60), email = String(req.body.email || '').trim().toLowerCase().slice(0, 120), password = typeof req.body.password === 'string' ? req.body.password : '';
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (await users.findOne({ email })) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    const user = { id: `u_${nanoid(12)}`, name, email, passwordHash: hashPassword(password), createdAt: new Date() };
    await users.insertOne({ ...user });
    res.status(201).json({ token: signToken({ sub: user.id }), user: publicUser(user) });
  } catch (e) { next(e); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase(), password = typeof req.body.password === 'string' ? req.body.password : '';
    if (tooMany(`login:${req.ip}:${email}`, 8)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    const user = await users.findOne({ email });
    if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Incorrect email or password.' });
    res.json({ token: signToken({ sub: user.id }), user: publicUser(user) });
  } catch (e) { next(e); }
});
app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try { const u = await users.findOne({ id: req.user.id }); return u ? res.json(publicUser(u)) : res.status(401).json({ error: 'Please sign in to continue.' }); } catch (e) { next(e); }
});

// ---- Authorization: every data route below only ever touches the signed-in user's own records ----
const auth = requireAuth;
const num = v => (Number.isFinite(+v) ? +v : null);
const cleanDive = d => {
  const ts = num(d?.ts), f = num(d?.f);
  if (!ts || ts < 1e12 || f == null || f < 0 || f > 86400) return null;
  return { ts, task: String(d.task || 'Untitled dive').slice(0, 60), f: Math.round(f), dep: Math.max(0, Math.round(num(d.dep) || 0)),
    dist: Math.max(0, Math.round(num(d.dist) || 0)), score: Math.min(100, Math.max(0, Math.round(num(d.score) || 0))) };
};
const FOUND = ['wreck', 'ruins', 'vents', 'floor'];

app.get('/api/health', (_req, res) => res.json({ status: 'ok', storage: 'mongodb' }));

app.get('/api/state', auth, async (req, res, next) => {
  try {
    const log = await dives.find({ uid: req.user.id }, { projection: { _id: 0, uid: 0 } }).sort({ ts: 1 }).limit(5000).toArray();
    const p = (await profiles.findOne({ uid: req.user.id }, { projection: { _id: 0, uid: 0 } })) || {};
    res.json({ log, tasks: p.tasks || [], found: p.found || [], goal: p.goal || null });
  } catch (e) { next(e); }
});

app.post('/api/dives', auth, async (req, res, next) => {
  try {
    const list = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 500).map(cleanDive).filter(Boolean);
    if (!list.length) return res.status(400).json({ error: 'No valid dives in request.' });
    await dives.bulkWrite(list.map(d => ({ updateOne: { filter: { uid: req.user.id, ts: d.ts }, update: { $setOnInsert: { ...d, uid: req.user.id } }, upsert: true } })));
    res.status(201).json({ saved: list.length });
  } catch (e) { next(e); }
});

app.put('/api/profile', auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 200).map(t => ({ n: String(t?.n || '').slice(0, 60), d: t?.d ? 1 : 0 })).filter(t => t.n);
    const found = (Array.isArray(b.found) ? b.found : []).filter(f => FOUND.includes(f));
    const goal = Math.min(600, Math.max(5, Math.round(num(b.goal) || 60)));
    await profiles.updateOne({ uid: req.user.id }, { $set: { tasks, found, goal, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Delete everything stored for the signed-in user.
app.delete('/api/data', auth, async (req, res, next) => {
  try { await dives.deleteMany({ uid: req.user.id }); await profiles.deleteOne({ uid: req.user.id }); res.json({ ok: true }); } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });
app.listen(PORT, () => console.log(`Abyss API on http://localhost:${PORT}`));
