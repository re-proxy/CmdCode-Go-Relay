import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { randomToken } from "./crypto.mjs";
import { whoami } from "./upstream.mjs";

/**
 * `node src/server.mjs login`
 *
 * Runs the OAuth login locally instead of on the relay host.
 *
 * Command Code's consent page only accepts a loopback callback, so a relay on a
 * NAS or an internal server can never receive it directly — its address is not
 * loopback and the page refuses to use one. This command listens on the machine
 * where the browser runs, receives the credential, and either prints it for
 * pasting into the relay or submits it straight to the relay's admin API.
 *
 * It needs no master key and no data file: it is a one-shot helper.
 */

function parseArgs(argv) {
  const options = {
    port: 0,
    relay: null,
    password: process.env.RELAY_ADMIN_PASSWORD ?? "",
    name: "",
    json: false,
    open: true,
    timeoutMs: 5 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--port") options.port = Number(next()) || 0;
    else if (arg === "--relay") options.relay = next();
    else if (arg === "--password") options.password = next();
    else if (arg === "--name") options.name = next();
    else if (arg === "--timeout") options.timeoutMs = (Number(next()) || 300) * 1000;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
  }
  return options;
}

function help() {
  return `Usage: node src/server.mjs login [options]

Runs the Command Code login on this machine and hands the key to a relay.
Command Code only accepts a localhost callback, so this is the reliable way to
add an account to a relay that runs somewhere else.

Options:
  --relay <url>        Relay base URL, e.g. http://192.168.1.10:8317
                       Omit to just print the key for pasting into the console.
  --password <pw>      Relay admin password (or set RELAY_ADMIN_PASSWORD).
  --name <name>        Account name to register (defaults to the user name).
  --port <n>           Fixed local callback port (default: any free port).
  --timeout <seconds>  Give up after this long (default 300).
  --json               Print a JSON result instead of prose.
  --no-open            Do not try to open a browser.
  -h, --help           Show this message.
`;
}

function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [command, args] = commands[process.platform] ?? ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed either way.
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error("callback payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parsePayload(raw, contentType) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const looksJson = text.startsWith("{") || contentType === "application/json";
  if (looksJson) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through
    }
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

const SUCCESS_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Login complete</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;
margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7e9ee}
.card{max-width:520px;padding:36px;border-radius:16px;background:#14171c;border:1px solid #222833}
h1{font-size:18px;margin:0 0 10px}p{color:#9aa3b2;line-height:1.6;margin:6px 0}</style></head>
<body><div class="card"><h1>登录完成</h1><p>可以关闭这个页面了，回到终端继续。</p></div></body></html>`;

const FAILURE_PAGE = (detail) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Login failed</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC",sans-serif;
margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7e9ee}
.card{max-width:520px;padding:36px;border-radius:16px;background:#14171c;border:1px solid #222833}
h1{font-size:18px;margin:0 0 10px}p{color:#9aa3b2;line-height:1.6;margin:6px 0}code{background:#0f1217;padding:2px 6px;border-radius:5px}</style></head>
<body><div class="card"><h1>登录未完成</h1><p>${String(detail ?? "").replace(/[<>&"]/g, "")}</p>
<p>回到终端重新运行 <code>login</code>。</p></div></body></html>`;

/** Submits the key to a relay's admin API. */
async function submitToRelay({ relay, password, apiKey, name }) {
  const base = String(relay).replace(/\/+$/, "");
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) {
    throw new Error(`relay rejected the admin password (${login.status})`);
  }
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("relay did not return a session cookie");

  const res = await fetch(`${base}/admin/api/accounts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: apiKey, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `relay returned ${res.status}`);
  }
  return body.account;
}

export async function runLoginCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(help());
    return 0;
  }

  const state = randomToken(24);
  const json = options.json;
  // In --json mode stdout must stay machine-readable, so progress goes to stderr.
  const say = (message) => {
    if (json) process.stderr.write(`${message}\n`);
    else process.stdout.write(`${message}\n`);
  };

  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // The consent page posts cross-origin to this loopback port.
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("access-control-allow-private-network", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/callback/complete") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(SUCCESS_PAGE);
      return;
    }

    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Not found" }));
      return;
    }

    let payload;
    try {
      const raw = req.method === "POST" ? await readBody(req) : "";
      payload = {
        ...Object.fromEntries(url.searchParams.entries()),
        ...parsePayload(raw, String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()),
      };
    } catch (error) {
      res.writeHead(413, { "content-type": "text/html; charset=utf-8" });
      res.end(FAILURE_PAGE(error.message));
      return;
    }

    if (payload.error) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(FAILURE_PAGE(`${payload.error}: ${payload.error_description ?? ""}`));
      finish({ ok: false, error: String(payload.error) });
      return;
    }

    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
    if (!apiKey) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(FAILURE_PAGE("callback carried no API key"));
      return;
    }

    const isJson = String(req.headers["content-type"] ?? "").includes("application/json");
    if (isJson) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(303, { location: "/callback/complete", "cache-control": "no-store" });
      res.end();
    }

    finish({
      ok: true,
      apiKey,
      userName: payload.userName ?? null,
      userId: payload.userId ?? null,
      keyName: payload.keyName ?? null,
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address();
  const callback = `http://127.0.0.1:${port}/callback`;
  const url =
    `${config.studioBase}/studio/auth/cli` +
    `?callback=${encodeURIComponent(callback)}` +
    `&state=${encodeURIComponent(state)}` +
    `&mode=redirect`;

  say("在本机浏览器完成授权，回调会落到本机，不会碰到 Relay 服务器。\n");
  say(`  登录地址：${url}\n`);
  say(`  回调地址：${callback}\n`);
  say("等待授权…（Ctrl+C 取消）\n");
  if (options.open) openBrowser(url);

  const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), options.timeoutMs);
  const result = await done;
  clearTimeout(timer);
  server.close();
  server.closeAllConnections?.();

  if (!result.ok) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: result.error })}\n`);
    else process.stderr.write(`登录失败：${result.error}\n`);
    return 1;
  }

  // Confirm the key with the upstream so the relay never receives a dead one.
  let who = null;
  try {
    who = await whoami(result.apiKey);
  } catch (error) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
    else process.stderr.write(`上游拒绝了这个密钥：${error?.message ?? error}\n`);
    return 1;
  }

  const userName = result.userName ?? who?.user?.userName ?? who?.user?.name ?? null;

  if (options.relay) {
    if (!options.password) {
      const message = "缺少 --password（或设置 RELAY_ADMIN_PASSWORD）才能自动写入 Relay";
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, apiKey: result.apiKey })}\n`);
      else process.stderr.write(`${message}\n\n可以直接把下面的 Key 粘进管理页：\n\n${result.apiKey}\n`);
      return 1;
    }
    try {
      const account = await submitToRelay({
        relay: options.relay,
        password: options.password,
        apiKey: result.apiKey,
        name: options.name || userName,
      });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, account, userName })}\n`);
      } else {
        process.stdout.write(`\n已写入 Relay：${account?.name ?? userName ?? "account"}（${options.relay}）\n`);
      }
      return 0;
    } catch (error) {
      const message = error?.message ?? String(error);
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, apiKey: result.apiKey })}\n`);
      else process.stderr.write(`写入 Relay 失败：${message}\n\n手动粘贴这个 Key：\n\n${result.apiKey}\n`);
      return 1;
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, apiKey: result.apiKey, userName })}\n`);
  } else {
    process.stdout.write(`\n登录成功：${userName ?? "unknown user"}\n\n`);
    process.stdout.write("把下面这串 API Key 粘到 Relay 管理页「粘贴回调 / API Key」：\n\n");
    process.stdout.write(`  ${result.apiKey}\n\n`);
    process.stdout.write("下次可以加 --relay http://<relay地址>:8317 让它自动写入。\n");
  }
  return 0;
}
