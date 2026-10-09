const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const config = { owner: 'repo-owner', repo: 'solutions', branch: 'main', pathTemplate: 'solutions/{slug}', token: 'test-token', acceptedOnly: true };
function worker() {
  const data = { config: { ...config } }, calls = [];
  const ctx = vm.createContext({ console, URL, TextEncoder, AbortSignal, btoa, setTimeout, clearTimeout,
    fetch: async (url, opts = {}) => { calls.push({ url, ...opts }); return { ok: true, json: async () => ({ sha: 'new', tree: { sha: 'tree' } }) }; },
    chrome: {
      storage: { local: { get: async key => key === null ? structuredClone(data) : { [key]: structuredClone(data[key]) },
        set: async value => Object.assign(data, structuredClone(value)), remove: async keys => keys.forEach(k => delete data[k]), setAccessLevel: async () => {} } },
      runtime: { onMessage: { addListener: fn => { ctx.listener = fn; } }, getManifest: () => ({ version: '1.0.1' }) }, tabs: { query: async () => [] }
    }
  });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), ctx);
  vm.runInContext('sleep = async () => {};', ctx);
  return { ctx, data, calls };
}
test('branch updates never force-push and reject conflicts', async () => {
  const { ctx, calls } = worker(); await ctx.updateRef(config, 'new');
  assert.equal(JSON.parse(calls[0].body).force, false);
  ctx.fetch = async () => ({ ok: false, status: 422, text: async () => 'not fast forward' });
  await assert.rejects(ctx.updateRef(config, 'new'), /422/);
});
test('cache separates repository, branch, path and acceptance mode', async () => {
  const { ctx } = worker(); await ctx.setSyncedMap(config, { 'two-sum': { submissionId: 42 } });
  assert.equal((await ctx.getSyncedMap(config))['two-sum'].submissionId, 42);
  for (const update of [{ repo: 'other' }, { branch: 'other' }, { pathTemplate: 'new/{slug}' }, { acceptedOnly: false }]) {
    assert.equal(Object.keys(await ctx.getSyncedMap({ ...config, ...update })).length, 0);
  }
});
test('auto-sync skips rejected, duplicate and older submissions without requests', async () => {
  const { ctx, calls } = worker();
  await ctx.syncSingleSubmission({ id: 1, title_slug: 'two-sum', status_display: 'Wrong Answer' }, 7);
  await ctx.setSyncedMap(config, { 'two-sum': { submissionId: 2, submissionTimestamp: 200 } });
  for (const id of [1, 2]) await ctx.syncSingleSubmission({ id, title_slug: 'two-sum', status_display: 'Accepted', timestamp: id * 100 }, 7);
  assert.equal(calls.length, 0);
});
test('telemetry is opt-in and never includes the GitHub token', async () => {
  const { ctx, data, calls } = worker(); await ctx.sendTelemetry('owner', 'repo', 'auto_sync_complete', 1);
  assert.equal(calls.length, 0);
  Object.assign(data.config, { telemetryEnabled: true, telemetryUrl: 'https://dashboard.example', telemetryKey: 'separate-key' });
  await ctx.sendTelemetry('owner', 'repo', 'auto_sync_complete', 1);
  assert.equal(calls[0].url, 'https://dashboard.example/api/telemetry');
  assert.equal(calls[0].headers['X-Telemetry-Key'], 'separate-key');
  assert.ok(!calls[0].body.includes('test-token'));
});
test('queue serializes jobs and recovers after an error', async () => {
  const { ctx } = worker(), seen = [];
  const a = ctx.enqueueSync(async () => { seen.push('a'); await new Promise(r => setTimeout(r, 5)); seen.push('b'); });
  const b = ctx.enqueueSync(async () => { seen.push('c'); throw Error('failure'); });
  const c = ctx.enqueueSync(async () => seen.push('d'));
  await Promise.all([a,b,c]); assert.deepEqual(seen, ['a','b','c','d']);
});
test('path templates reject traversal and absolute paths', () => {
  const { ctx } = worker();
  for (const pathTemplate of ['../{slug}', '/{slug}', 'x/../{slug}', '.git/{slug}', 'x\\{slug}', 'x//{slug}']) assert.throws(() => ctx.solutionFolder({ pathTemplate }, 'two-sum'));
  assert.equal(ctx.solutionFolder(config, 'two-sum'), 'solutions/two-sum');
});
test('commit identity comes from token owner, not repository organization', async () => {
  const { ctx } = worker(); ctx.githubApi = async () => ({ id: 123, login: 'developer', name: 'Developer', email: null });
  const current = { ...config }; await ctx.resolveCommitAuthor(current);
  assert.equal(current.authorEmail, '123+developer@users.noreply.github.com');
});
function mockSubmission(ctx) {
  ctx.resolveCommitAuthor = async () => {};
  ctx.ensureBranch = async () => ({ object: { sha: 'parent' } });
  ctx.getCommit = async () => ({ tree: { sha: 'tree' } });
  ctx.sendToTab = async () => ({ ok: true, detail: { code: 'return 42', question: { title: 'Two Sum', difficulty: 'Easy' } } });
  return { id: 42, title_slug: 'two-sum', status_display: 'Accepted', lang: 'python3', timestamp: 1700000000 };
}
test('successful auto-sync writes code and README then records success', async () => {
  const { ctx } = worker(), submission = mockSubmission(ctx); let args;
  ctx.pushBackdatedCommit = async (...value) => { args = value; };
  await ctx.syncSingleSubmission(submission, 7);
  assert.equal(args[1][0].path, 'solutions/two-sum/two-sum.py'); assert.equal(args[1][0].content, 'return 42');
  assert.equal(args[1][1].path, 'solutions/two-sum/README.md'); assert.equal(args[3], 1700000000);
  assert.equal((await ctx.getSyncedMap(config))['two-sum'].submissionId, 42);
});
test('failed branch update never populates success cache', async () => {
  const { ctx, data } = worker(), submission = mockSubmission(ctx);
  ctx.pushBackdatedCommit = async () => { throw Error('branch changed'); };
  await ctx.syncSingleSubmission(submission, 7);
  assert.equal(Object.keys(await ctx.getSyncedMap(config)).length, 0); assert.equal(data.progress.state, 'error');
});
test('manifest uses Chrome MV3 background declaration', () => {
  const m = JSON.parse(fs.readFileSync('manifest.json')); assert.deepEqual(m.background, { service_worker: 'background.js' });
  assert.ok(!m.permissions.includes('webRequest'));
});


test('missing target branch starts from existing default branch without bootstrap', async () => {
  const { ctx } = worker(); let created = false, bootstrap = false;
  const current = { ...config, branch: 'archive' };
  ctx.tryGetBranchRef = async c => c.branch === 'main' || created ? { object: { sha: 'existing-tip' } } : null;
  ctx.githubApi = async () => ({ default_branch: 'main' });
  ctx.createRef = async (c, sha) => { assert.equal(c.branch, 'archive'); assert.equal(sha, 'existing-tip'); created = true; };
  ctx.initializeEmptyRepo = async () => { bootstrap = true; };
  assert.equal((await ctx.ensureBranch(current)).object.sha, 'existing-tip');
  assert.equal(bootstrap, false);
});
