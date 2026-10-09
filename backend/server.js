const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('node:path');
const fs = require('node:fs');
const { timingSafeEqual, createHash } = require('node:crypto');

function equalSecret(left, right) {
  if (typeof left !== 'string' || !right) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}

async function createApp(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production && (!env.ADMIN_USER || !env.ADMIN_PASSWORD || !env.TELEMETRY_KEY || !env.DB_PATH)) {
    throw new Error('Production requires ADMIN_USER, ADMIN_PASSWORD, TELEMETRY_KEY and persistent DB_PATH.');
  }
  if (!!env.ADMIN_USER !== !!env.ADMIN_PASSWORD) throw new Error('Set both ADMIN_USER and ADMIN_PASSWORD.');
  const dbPath = env.DB_PATH || path.join(__dirname, 'telemetry.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, error => error ? reject(error) : resolve(connection));
  });
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(error) { error ? reject(error) : resolve({ id: this.lastID }); });
  });
  const get = sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
  const all = sql => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
  const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  try {
    await run('PRAGMA journal_mode = WAL');
    await run(`CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, repo TEXT NOT NULL,
      action TEXT NOT NULL, problemsSynced INTEGER DEFAULT 0, version TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (error) { await close(); throw error; }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    next();
  });
  const allowed = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  app.use(cors({ origin(origin, callback) { callback(null, !origin || allowed.includes(origin)); } }));
  app.use(express.json({ limit: '8kb' }));
  app.get('/health', async (req, res, next) => {
    try { await get('SELECT 1'); res.json({ status: 'ok' }); } catch (error) { next(error); }
  });
  app.post('/api/telemetry', async (req, res, next) => {
    if (!env.TELEMETRY_KEY) return res.status(503).json({ error: 'Telemetry collection is disabled.' });
    if (!equalSecret(req.get('X-Telemetry-Key'), env.TELEMETRY_KEY)) return res.status(401).json({ error: 'Invalid telemetry key.' });
    const { owner, repo, action, problemsSynced, version } = req.body || {};
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
        typeof repo !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) ||
        !['bulk_sync_complete', 'auto_sync_complete'].includes(action) ||
        !Number.isInteger(problemsSynced) || problemsSynced < 0 || problemsSynced > 100000 ||
        typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
      return res.status(400).json({ error: 'Invalid telemetry fields.' });
    }
    try {
      const result = await run('INSERT INTO telemetry (owner, repo, action, problemsSynced, version) VALUES (?, ?, ?, ?, ?)', [owner, repo, action, problemsSynced, version]);
      res.status(201).json({ success: true, id: result.id });
    } catch (error) { next(error); }
  });
  // Collector has its own key; dashboard/logs require a separate admin credential.
  app.use((req, res, next) => {
    if (!env.ADMIN_USER && !production) return next();
    const header = req.get('Authorization') || '';
    const credentials = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
    const separator = credentials.indexOf(':');
    if (separator >= 0 && equalSecret(credentials.slice(0, separator), env.ADMIN_USER) && equalSecret(credentials.slice(separator + 1), env.ADMIN_PASSWORD)) return next();
    res.set('WWW-Authenticate', 'Basic realm="LeetSync dashboard", charset="UTF-8"');
    return res.status(401).json({ error: 'Dashboard authentication required.' });
  });
  app.get('/api/stats', async (req, res, next) => {
    try {
      const row = await get('SELECT COUNT(DISTINCT owner) AS totalUsers, COUNT(id) AS totalSyncs, COALESCE(SUM(problemsSynced), 0) AS totalProblemsSynced FROM telemetry');
      res.json(row);
    } catch (error) { next(error); }
  });
  app.get('/api/logs', async (req, res, next) => {
    try { res.json(await all('SELECT owner, repo, action, problemsSynced, version, timestamp FROM telemetry ORDER BY id DESC LIMIT 200')); }
    catch (error) { next(error); }
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error('Request failed:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  });
  return { app, close };
}

if (require.main === module) {
  createApp().then(({ app, close }) => {
    const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
    const server = app.listen(process.env.PORT || 3000, host, () => console.log(`LeetSync listening on ${host}:${server.address().port}`));
    const shutdown = () => server.close(() => close().then(() => process.exit(0)));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch(error => { console.error('Startup failed:', error.message); process.exitCode = 1; });
}
module.exports = { createApp };
