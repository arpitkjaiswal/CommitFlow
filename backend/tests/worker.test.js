const test = require("node:test");
const assert = require("node:assert/strict");

let handleRequest;
test.before(async () => {
  ({ handleRequest } = await import("../worker.mjs"));
});

function env(overrides = {}) {
  const calls = [];
  return {
    calls,
    DB: {
      prepare(sql) {
        const record = { sql, values: null };
        calls.push(record);
        return {
          bind(...values) {
            record.values = values;
            return this;
          },
          async first() {
            if (sql === "SELECT 1 AS ok") return { ok: 1 };
            return { totalUsers: 2, totalSyncs: 7, totalProblemsSynced: 14 };
          },
          async run() {
            return { meta: { last_row_id: 42 } };
          },
          async all() {
            return { results: [{ owner: "dev", repo: "solutions", action: "auto_sync_complete", problemsSynced: 1, version: "1.0.1", timestamp: "2026-10-09 12:00:00" }] };
          },
        };
      },
    },
    ASSETS: {
      async fetch() {
        return new Response("<html>dashboard</html>", { headers: { "Content-Type": "text/html" } });
      },
    },
    ADMIN_USER: "admin",
    ADMIN_PASSWORD: "dashboard-password",
    TELEMETRY_KEY: "collector-key",
    CORS_ORIGINS: "chrome-extension://abc123",
    ...overrides,
  };
}

function basic(user, password) {
  return "Basic " + btoa(user + ":" + password);
}

test("health uses D1 and returns the app health response", async () => {
  const bindings = env();
  const response = await handleRequest(new Request("https://example.workers.dev/health"), bindings);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(bindings.calls[0].sql, "SELECT 1 AS ok");
});

test("telemetry authenticates, validates, and inserts without requiring dashboard auth", async () => {
  const bindings = env();
  const request = new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telemetry-Key": "collector-key" },
    body: JSON.stringify({ owner: "developer", repo: "solutions", action: "auto_sync_complete", problemsSynced: 1, version: "1.0.1" }),
  });
  const response = await handleRequest(request, bindings);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { success: true, id: 42 });
  assert.deepEqual(bindings.calls[0].values, ["developer", "solutions", "auto_sync_complete", 1, "1.0.1"]);
});

test("telemetry rejects wrong keys, malformed JSON, invalid fields and oversized bodies", async () => {
  const wrongKey = await handleRequest(new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    headers: { "X-Telemetry-Key": "wrong" },
    body: "{}",
  }), env());
  assert.equal(wrongKey.status, 401);

  const malformed = await handleRequest(new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    headers: { "X-Telemetry-Key": "collector-key" },
    body: "{",
  }), env());
  assert.equal(malformed.status, 400);

  const invalid = await handleRequest(new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    headers: { "X-Telemetry-Key": "collector-key" },
    body: JSON.stringify({ owner: "<script>", repo: "solutions", action: "auto_sync_complete", problemsSynced: 1, version: "1.0.1" }),
  }), env());
  assert.equal(invalid.status, 400);

  const tooLarge = await handleRequest(new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    headers: { "X-Telemetry-Key": "collector-key" },
    body: "x".repeat(9000),
  }), env());
  assert.equal(tooLarge.status, 413);

  const disabled = await handleRequest(new Request("https://example.workers.dev/api/telemetry", {
    method: "POST",
    body: "{}",
  }), env({ TELEMETRY_KEY: "" }));
  assert.equal(disabled.status, 503);
});

test("dashboard routes and static assets require admin basic auth", async () => {
  const bindings = env();
  const denied = await handleRequest(new Request("https://example.workers.dev/api/stats"), bindings);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("WWW-Authenticate"), /LeetSync dashboard/);

  const headers = { Authorization: basic("admin", "dashboard-password") };
  const stats = await handleRequest(new Request("https://example.workers.dev/api/stats", { headers }), bindings);
  assert.equal(stats.status, 200);
  assert.deepEqual(await stats.json(), { totalUsers: 2, totalSyncs: 7, totalProblemsSynced: 14 });

  const logs = await handleRequest(new Request("https://example.workers.dev/api/logs", { headers }), bindings);
  assert.equal(logs.status, 200);
  assert.equal((await logs.json())[0].owner, "dev");

  const page = await handleRequest(new Request("https://example.workers.dev/", { headers }), bindings);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<html>dashboard</html>");
  assert.equal(page.headers.get("X-Frame-Options"), "DENY");
  assert.equal(page.headers.get("Cache-Control"), "no-store");
});

test("preflight allows configured extension origin and withholds CORS for others", async () => {
  const request = new Request("https://example.workers.dev/api/telemetry", {
    method: "OPTIONS",
    headers: {
      Origin: "chrome-extension://abc123",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-telemetry-key",
    },
  });
  const allowed = await handleRequest(request, env());
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "chrome-extension://abc123");
  assert.match(allowed.headers.get("Access-Control-Allow-Headers"), /X-Telemetry-Key/);

  const denied = await handleRequest(new Request(request.url, {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" },
  }), env());
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("unknown API routes remain protected", async () => {
  const response = await handleRequest(new Request("https://example.workers.dev/api/unknown"), env());
  assert.equal(response.status, 401);
});
