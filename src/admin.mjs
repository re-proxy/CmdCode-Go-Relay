import { randomToken, safeEqual } from "./crypto.mjs";
import { config } from "./config.mjs";
import { listModels } from "./upstream.mjs";
import { renderAdminPage } from "./admin-ui.mjs";

const SESSION_COOKIE = "relay_session";
const sessions = new Map();

function sweepSessions() {
  const cutoff = Date.now() - config.sessionTtlMs;
  for (const [token, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(token);
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function currentSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > config.sessionTtlMs) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

function requireSession(req, res) {
  const session = currentSession(req);
  if (!session) {
    json(res, 401, { error: "not_authenticated" });
    return null;
  }
  return session;
}

export async function adminRouter({ req, res, url, path, store, relay, pool, loginBroker, clientOrigin, requestOrigin }) {
  // ------------------------------------------------------------ login/logout
  if (path === "/admin/login" && req.method === "POST") {
    const body = await readBody(req);
    if (!body?.password || !safeEqual(body.password, config.adminPassword)) {
      json(res, 401, { error: "invalid_password" });
      return;
    }
    sweepSessions();
    const token = randomToken(32);
    sessions.set(token, { createdAt: Date.now() });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
        config.sessionTtlMs / 1000,
      )}`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === "/admin/logout" && req.method === "POST") {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --------------------------------------------------------------- the page
  if ((path === "/" || path === "/admin" || path === "/index.html") && req.method === "GET") {
    const session = currentSession(req);
    const body = renderAdminPage({
      authenticated: Boolean(session),
      baseUrl: clientOrigin(req),
    });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  // -------------------------------------------------------------- the API
  if (path.startsWith("/admin/api/")) {
    if (!requireSession(req, res)) return;
    await adminApi({ req, res, path, store, relay, pool, loginBroker, clientOrigin, requestOrigin });
    return;
  }

  json(res, 404, { error: "not_found" });
}

async function adminApi({ req, res, path, store, relay, pool, loginBroker, clientOrigin, requestOrigin }) {
  // overview ---------------------------------------------------------------
  if (path === "/admin/api/overview" && req.method === "GET") {
    json(res, 200, {
      relay: {
        requests: relay.stats.requests,
        errors: relay.stats.errors,
        startedAt: relay.stats.startedAt,
        maxConcurrent: config.maxConcurrent,
        upstream: config.upstreamBase,
        cliVersion: config.cliVersion,
      },
      accounts: store.listAccounts(),
      apiKeys: store.listApiKeys(),
      usage: store.listUsage(50),
      pool: await pool.stats(),
    });
    return;
  }

  // accounts ---------------------------------------------------------------
  if (path === "/admin/api/accounts" && req.method === "POST") {
    const body = await readBody(req);
    const account = await loginBroker.submitPasted({ value: body.value, name: body.name });
    json(res, 200, { account });
    return;
  }

  if (path === "/admin/api/accounts/import-local" && req.method === "POST") {
    const body = await readBody(req);
    const local = loginBroker.importLocal();
    const account = await loginBroker.submitPasted({
      value: local.apiKey,
      name: body?.name || local.userName,
    });
    json(res, 200, { account });
    return;
  }

  if (path === "/admin/api/accounts/login-url" && req.method === "POST") {
    // The callback must be loopback, so the origin comes from the request's own
    // Host header rather than the configured public URL.
    const started = loginBroker.start({ requestOrigin: requestOrigin(req) });
    json(res, 200, started);
    return;
  }

  if (path === "/admin/api/accounts/login-status" && req.method === "GET") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    const session = id ? loginBroker.getSession(id) : null;
    json(res, session ? 200 : 404, session ?? { error: "not_found" });
    return;
  }

  if (path === "/admin/api/accounts/check" && req.method === "POST") {
    const body = await readBody(req);
    if (body?.id) {
      const result = await relay.checkAccount(body.id);
      json(res, 200, { result });
    } else {
      const results = await relay.checkAllAccounts();
      json(res, 200, { results });
    }
    return;
  }

  // Stored snapshot only; refreshing is a separate, explicit call so the
  // console's polling never turns into upstream requests.
  if (path === "/admin/api/usage" && req.method === "GET") {
    const accounts = store.listAccounts().map((a) => ({
      id: a.id,
      account: a.name,
      enabled: a.enabled,
      usageCheckedAt: a.usageCheckedAt ?? null,
      usage: a.usage ?? null,
    }));
    json(res, 200, { accounts });
    return;
  }

  if (path === "/admin/api/usage/refresh" && req.method === "POST") {
    const results = await relay.refreshAllUsage();
    json(res, 200, { results });
    return;
  }

  if (path === "/admin/api/accounts/credits" && req.method === "POST") {
    const body = await readBody(req);
    const result = await relay.refreshCredits(body?.id);
    json(res, 200, result);
    return;
  }

  // model catalog ----------------------------------------------------------
  if (path === "/admin/api/models" && req.method === "GET") {
    const models = await listModels();
    json(res, 200, { models, prefs: store.getModelPrefs() });
    return;
  }

  if (path === "/admin/api/models/refresh" && req.method === "POST") {
    const models = await listModels();
    json(res, 200, { models });
    return;
  }

  if (path === "/admin/api/models/prefs" && req.method === "POST") {
    const body = await readBody(req);
    store.setModelPrefs(body?.prefs ?? {});
    json(res, 200, { ok: true });
    return;
  }

  // api keys ---------------------------------------------------------------
  if (path === "/admin/api/keys" && req.method === "POST") {
    const body = await readBody(req);
    const created = store.createApiKey(body?.name);
    json(res, 200, created);
    return;
  }

  if (path === "/admin/api/keys/enabled" && req.method === "POST") {
    const body = await readBody(req);
    const updated = store.setApiKeyEnabled(body?.id, body?.enabled);
    json(res, updated ? 200 : 404, updated ?? { error: "not_found" });
    return;
  }

  // usage ------------------------------------------------------------------
  if (path === "/admin/api/usage" && req.method === "GET") {
    json(res, 200, { usage: store.listUsage(config.usageLimit) });
    return;
  }

  // account mutations by id ------------------------------------------------
  const accountMatch = /^\/admin\/api\/accounts\/([A-Za-z0-9_-]+)$/.exec(path);
  if (accountMatch) {
    const id = accountMatch[1];
    if (req.method === "PATCH" || req.method === "POST") {
      const body = await readBody(req);
      const patch = {};
      if (typeof body?.name === "string") patch.name = body.name;
      if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
      // Clearing the parked flag lets a user retry the existing key after
      // fixing an upstream-side problem that was mistaken for a bad credential.
      if (body?.clearReauth === true) patch.needsReauth = false;
      if (typeof body?.apiKey === "string" && body.apiKey.trim()) {
        if (!store.getAccount(id)) {
          json(res, 404, { error: "not_found" });
          return;
        }
        store.setAccountCredential(id, body.apiKey.trim());
        const check = await relay.checkAccount(id);
        json(res, 200, { account: store.listAccounts().find((a) => a.id === id) ?? null, check });
        return;
      }
      const updated = store.updateAccount(id, patch);
      if (!updated) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, { account: updated });
      return;
    }
    if (req.method === "DELETE") {
      const removed = store.removeAccount(id);
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "not_found" });
      return;
    }
  }

  const keyMatch = /^\/admin\/api\/keys\/([A-Za-z0-9_-]+)$/.exec(path);
  if (keyMatch && req.method === "DELETE") {
    const removed = store.removeApiKey(keyMatch[1]);
    json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "not_found" });
    return;
  }

  json(res, 404, { error: "not_found" });
}
