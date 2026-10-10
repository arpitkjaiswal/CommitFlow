const MAX_BODY_BYTES = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function secretEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || right.length === 0) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

function allowedOriginHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.CORS_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telemetry-Key, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function secureResponse(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  );
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  for (const [name, value] of Object.entries(allowedOriginHeaders(request, env))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readLimitedBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(combined);
}

function validTelemetry(value) {
  return value &&
    typeof value.owner === "string" && /^[a-zA-Z0-9-]{1,39}$/.test(value.owner) &&
    typeof value.repo === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value.repo) &&
    ["bulk_sync_complete", "auto_sync_complete"].includes(value.action) &&
    Number.isInteger(value.problemsSynced) && value.problemsSynced >= 0 && value.problemsSynced <= 100000 &&
    typeof value.version === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.version);
}

async function isAdmin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header);
  if (!match || !env.ADMIN_USER || !env.ADMIN_PASSWORD) return false;
  let credentials;
  try {
    const binary = atob(match[1]);
    credentials = decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return false;
  }
  const separator = credentials.indexOf(":");
  if (separator < 0) return false;
  const user = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  const userMatches = await secretEquals(user, env.ADMIN_USER);
  const passwordMatches = await secretEquals(password, env.ADMIN_PASSWORD);
  return userMatches && passwordMatches;
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/health" && method === "GET") {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ status: "ok" });
  }

  if (path === "/api/telemetry" && method === "POST") {
    if (!env.TELEMETRY_KEY) return json({ error: "Telemetry collection is disabled." }, 503);
    if (!await secretEquals(request.headers.get("X-Telemetry-Key"), env.TELEMETRY_KEY)) {
      return json({ error: "Invalid telemetry key." }, 401);
    }
    const text = await readLimitedBody(request);
    if (text === null) return json({ error: "Request too large." }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    if (!validTelemetry(body)) return json({ error: "Invalid telemetry fields." }, 400);
    const result = await env.DB.prepare(
      "INSERT INTO telemetry (owner, repo, action, problemsSynced, version) VALUES (?, ?, ?, ?, ?)",
    ).bind(body.owner, body.repo, body.action, body.problemsSynced, body.version).run();
    return json({ success: true, id: result.meta?.last_row_id ?? null }, 201);
  }

  if (!await isAdmin(request, env)) {
    return secureResponse(new Response(
      JSON.stringify({ error: "Dashboard authentication required." }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": 'Basic realm="CommitFlow dashboard", charset="UTF-8"',
        },
      },
    ), request, env);
  }

  if (path === "/api/stats" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT COUNT(DISTINCT owner) AS totalUsers, COUNT(id) AS totalSyncs, COALESCE(SUM(problemsSynced), 0) AS totalProblemsSynced FROM telemetry",
    ).first();
    return json({
      totalUsers: row?.totalUsers ?? 0,
      totalSyncs: row?.totalSyncs ?? 0,
      totalProblemsSynced: row?.totalProblemsSynced ?? 0,
    });
  }

  if (path === "/api/logs" && method === "GET") {
    const result = await env.DB.prepare(
      "SELECT owner, repo, action, problemsSynced, version, timestamp FROM telemetry ORDER BY id DESC LIMIT 200",
    ).all();
    return json(result.results || []);
  }

  if (path.startsWith("/api/")) return json({ error: "Not found." }, 404);
  if (method !== "GET" && method !== "HEAD") return json({ error: "Not found." }, 404);

  if (!env.ASSETS) return json({ error: "Not found." }, 404);
  return env.ASSETS.fetch(request);
}

export async function handleRequest(request, env) {
  try {
    return secureResponse(await route(request, env), request, env);
  } catch (error) {
    console.error("Request failed:", error?.message || "unknown error");
    return secureResponse(json({ error: "Internal server error." }, 500), request, env);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

