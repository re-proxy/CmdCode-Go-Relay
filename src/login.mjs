import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.mjs";
import { randomToken } from "./crypto.mjs";
import { whoami, fetchCredits } from "./upstream.mjs";
import { summarizeCredits } from "./credits.mjs";

/**
 * Account onboarding.
 *
 * Three ways in, in order of convenience:
 *   1. Browser login — open the official CLI login URL with the relay's own
 *      callback, which hands back an API key.
 *   2. Paste — drop the full callback URL (or just the key) into the admin page.
 *   3. Local import — read `~/.commandcode/auth.json` from a machine that
 *      already ran `cmd auth login`.
 */
export function createLoginBroker({ store }) {
  const sessions = new Map();

  function sweep() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(id);
    }
  }

  function start({ origin }) {
    sweep();
    const state = randomToken(24);
    const id = randomUUID();
    const callback = `${origin}/callback`;
    const url =
      `${config.studioBase}/studio/auth/cli` +
      `?callback=${encodeURIComponent(callback)}` +
      `&state=${encodeURIComponent(state)}` +
      `&mode=redirect`;
    sessions.set(id, {
      id,
      state,
      createdAt: Date.now(),
      status: "pending",
      result: null,
    });
    return { id, state, url, callback };
  }

  function sessionByState(state) {
    for (const session of sessions.values()) {
      if (session.state === state) return session;
    }
    return null;
  }

  async function complete(session, { apiKey, userId, userName, keyName }) {
    const info = await whoami(apiKey);
    const user = info?.user ?? {};
    const account = store.addAccount({
      name: userName || user.userName || user.name || `account-${store.listAccounts().length + 1}`,
      apiKey,
      userName: userName || user.userName || user.name || null,
      userId: userId || user.id || null,
      keyName: keyName || "relay-import",
    });
    session.status = "complete";
    session.result = account;
    store.updateAccount(account.id, {
      lastCheckedAt: new Date().toISOString(),
      lastCheckOk: true,
      lastCheckError: null,
      modelCount: null,
      orgId: info?.org?.id ?? null,
      planId: info?.org?.planId ?? null,
    });
    // Pull credits in the background; failure here never blocks onboarding.
    fetchCredits(apiKey, info?.org?.id ?? null)
      .then((data) => {
        const summary = summarizeCredits(data);
        if (!summary.available) return;
        store.updateAccount(account.id, {
          credits: summary,
          creditsCheckedAt: new Date().toISOString(),
        });
      })
      .catch(() => {});
    return account;
  }

  /** Handles both /callback and /callback/complete. */
  async function handleCallback(req, res, url, origin) {
    if (url.pathname === "/callback/complete") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderCompletePage());
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderErrorPage(error, url.searchParams.get("error_description")));
      return;
    }

    const apiKey = url.searchParams.get("apiKey");
    const state = url.searchParams.get("state");
    if (!apiKey) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderErrorPage(
          "missing_api_key",
          "The callback did not carry an API key. Copy the full callback URL from the address bar and paste it into the relay's admin page instead.",
        ),
      );
      return;
    }

    const session = state ? sessionByState(state) : null;
    try {
      await complete(session ?? { status: "pending" }, {
        apiKey,
        userId: url.searchParams.get("userId"),
        userName: url.searchParams.get("userName"),
        keyName: url.searchParams.get("keyName"),
      });
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderErrorPage("invalid_key", err?.message ?? String(err)));
      return;
    }

    res.writeHead(303, {
      location: `${origin}/callback/complete${state ? `?state=${encodeURIComponent(state)}` : ""}`,
      "cache-control": "no-store",
    });
    res.end();
  }

  /** Accepts either the full callback URL or a bare API key. */
  async function submitPasted({ value, name }) {
    const parsed = parseCallbackUrl(value);
    if (!parsed) {
      const apiKey = String(value ?? "").trim();
      if (!apiKey) throw new Error("Paste a callback URL or an API key");
      const account = await complete({ status: "pending" }, { apiKey, userName: name, keyName: "relay-paste" });
      return account;
    }
    if (parsed.error) {
      throw new Error(`Login was denied: ${parsed.error_description || parsed.error}`);
    }
    if (!parsed.apiKey) throw new Error("That URL has no apiKey parameter");
    return complete({ status: "pending" }, { ...parsed, userName: name || parsed.userName });
  }

  function importLocal() {
    const path = join(homedir(), ".commandcode", "auth.json");
    if (!existsSync(path)) {
      throw new Error(`No ${path} on this host — run \`cmd auth login\` here first, or use the browser/paste flow`);
    }
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`Could not read ${path}: ${err?.message ?? err}`);
    }
    const apiKey = typeof data?.apiKey === "string" ? data.apiKey.trim() : "";
    if (!apiKey) throw new Error(`${path} has no apiKey field`);
    return { apiKey, userId: data.userId, userName: data.userName, keyName: data.keyName };
  }

  return {
    start,
    handleCallback,
    submitPasted,
    importLocal,
    getSession(id) {
      const session = sessions.get(id);
      if (!session) return null;
      return { id: session.id, status: session.status, result: session.result };
    },
  };
}

function parseCallbackUrl(value) {
  const raw = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return {
      apiKey: url.searchParams.get("apiKey"),
      state: url.searchParams.get("state"),
      userId: url.searchParams.get("userId"),
      userName: url.searchParams.get("userName"),
      keyName: url.searchParams.get("keyName"),
      error: url.searchParams.get("error"),
      error_description: url.searchParams.get("error_description"),
    };
  } catch {
    return null;
  }
}

function shell(body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Command Code Relay</title>
<style>
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7e9ee}
.card{max-width:520px;padding:40px 36px;border-radius:16px;background:#14171c;border:1px solid #222833;box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 12px}
p{margin:8px 0;line-height:1.6;color:#a9b0be}
a{color:#7aa2ff}
code{background:#1c2129;padding:2px 6px;border-radius:6px;font-size:13px}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;letter-spacing:.02em}
.ok{background:rgba(34,197,94,.14);color:#4ade80}
.err{background:rgba(239,68,68,.14);color:#f87171}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function renderCompletePage() {
  return shell(`
    <span class="badge ok">已登录</span>
    <h1>账号已接入 Relay</h1>
    <p>可以关闭这个页面了。回到管理界面刷新，即可看到新账号与其套餐额度。</p>
    <p><a href="/">返回管理界面</a></p>
  `);
}

function renderErrorPage(code, detail) {
  const safeCode = escapeHtml(code ?? "error");
  const safeDetail = escapeHtml(detail ?? "");
  return shell(`
    <span class="badge err">失败</span>
    <h1>登录未完成</h1>
    <p><code>${safeCode}</code></p>
    ${safeDetail ? `<p>${safeDetail}</p>` : ""}
    <p>回到管理界面，用「粘贴回调地址 / API Key」的方式重试。</p>
    <p><a href="/">返回管理界面</a></p>
  `);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
