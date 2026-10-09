const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
test('production fails fast without configuration', async () => { await assert.rejects(createApp({ NODE_ENV: 'production' }), /Production requires/); });
test('HTTP auth, validation and persistent database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commitflow-'));
  const env = { NODE_ENV: 'production', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'test-password', TELEMETRY_KEY: 'collector-key', DB_PATH: path.join(dir, 'data.db') };
  const { app, close } = await createApp(env), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(r => server.close(r)); await close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, admin = { Authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
  assert.equal((await fetch(base+'/health')).status, 200);
  for (const route of ['/', '/api/logs', '/api/stats']) assert.equal((await fetch(base+route)).status, 401);
  assert.equal((await fetch(base+'/', { headers: admin })).status, 200);
  const body = { owner: 'developer', repo: 'solutions', action: 'auto_sync_complete', problemsSynced: 1, version: '1.0.1' };
  const post = (value, key = env.TELEMETRY_KEY) => fetch(base+'/api/telemetry', { method:'POST', headers:{'Content-Type':'application/json','X-Telemetry-Key':key},body:JSON.stringify(value) });
  assert.equal((await post(body, 'wrong')).status, 401);
  for (const value of [{...body,owner:'<script>'},{...body,problemsSynced:-1},{...body,problemsSynced:'1'},{...body,version:{}},null]) assert.equal((await post(value)).status,400);
  assert.equal((await post(body)).status,201);
  assert.deepEqual(await (await fetch(base+'/api/stats',{headers:admin})).json(),{totalUsers:1,totalSyncs:1,totalProblemsSynced:1});
  assert.equal((await (await fetch(base+'/api/logs',{headers:admin})).json())[0].owner,'developer');
  const second = await createApp(env), server2 = second.app.listen(0,'127.0.0.1'); await once(server2,'listening');
  try { assert.equal((await (await fetch(`http://127.0.0.1:${server2.address().port}/api/stats`,{headers:admin})).json()).totalSyncs,1); }
  finally { await new Promise(r=>server2.close(r)); await second.close(); }
});
