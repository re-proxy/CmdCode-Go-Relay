import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startMockUpstream } from "./mock-upstream.mjs";

/**
 * Tests for `node src/server.mjs login`, the local OAuth helper.
 *
 * That command is what makes a relay on another host usable at all: Command
 * Code only accepts a loopback callback, so the login has to run where the
 * browser is. These tests drive it like the consent page would.
 */

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const ROOT = new URL("..", import.meta.url).pathname;

/** Spawns the login CLI and resolves once its callback port is known. */
function startLogin(args, env) {
  const child = spawn(process.execPath, ["src/server.mjs", "login", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const state = { callback: null, child, get stdout() { return stdout; }, get stderr() { return stderr; } };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`login CLI did not print a callback URL:\n${stdout}${stderr}`)), 20000);
    const scan = () => {
      // Progress lines go to stdout normally and to stderr under --json.
      const match = /回调地址：(http:\/\/127\.0\.0\.1:\d+\/callback)/.exec(stdout + stderr);
      if (match) {
        clearTimeout(timer);
        state.callback = match[1];
        resolve();
      }
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      scan();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      scan();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`login CLI exited early:\n${stdout}${stderr}`));
    });
  });

  const exited = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return { state, ready, exited };
}

/** Posts like the consent page does, which is cross-origin urlencoded. */
async function deliver(callback, fields, contentType = "application/x-www-form-urlencoded") {
  const body =
    contentType === "application/json" ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
  return fetch(callback, {
    method: "POST",
    headers: { "content-type": contentType, origin: "https://commandcode.ai" },
    body,
    redirect: "manual",
  });
}

const dir = mkdtempSync(join(tmpdir(), "login-cli-"));
const upstream = await startMockUpstream();
const env = {
  RELAY_UPSTREAM_BASE: upstream.base,
  RELAY_STUDIO_BASE: "https://commandcode.ai",
};

try {
  // --- prints the key for manual pasting ---------------------------------
  {
    const { state, ready, exited } = startLogin(["--no-open", "--port", "0"], env);
    await ready;
    check("login CLI exposes a loopback callback", /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(state.callback), state.callback);

    const preflight = await fetch(state.callback, {
      method: "OPTIONS",
      headers: {
        origin: "https://commandcode.ai",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    check("login CLI answers the consent preflight", preflight.status === 204, `got ${preflight.status}`);
    check("login CLI grants private network access", preflight.headers.get("access-control-allow-private-network") === "true");

    const res = await deliver(state.callback, { apiKey: "test-key-good", state: "s1", userName: "localtester" });
    check("login CLI accepts an urlencoded POST", res.status === 303, `got ${res.status}`);

    const code = await exited;
    check("login CLI exits successfully", code === 0, `exit=${code} ${state.stderr}`);
    check("login CLI prints the key for pasting", state.stdout.includes("test-key-good"), state.stdout.slice(-300));
    check("login CLI names the user", /localtester/.test(state.stdout), state.stdout.slice(-200));
  }

  // --- JSON delivery ------------------------------------------------------
  {
    const { state, ready, exited } = startLogin(["--no-open", "--json"], env);
    await ready;
    const res = await deliver(state.callback, { apiKey: "test-key-good", userName: "jsontester" }, "application/json");
    check("login CLI accepts a JSON POST", res.status === 200, `got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    check("login CLI answers a JSON callback with success", body.success === true, JSON.stringify(body));

    const code = await exited;
    check("login CLI --json exits successfully", code === 0, `exit=${code}`);
    let parsed = null;
    try {
      parsed = JSON.parse(state.stdout.trim().split("\n").filter(Boolean).at(-1));
    } catch {
      parsed = null;
    }
    check("login CLI --json prints a machine readable result", parsed?.ok === true && parsed?.apiKey === "test-key-good", state.stdout.slice(-300));
  }

  // --- rejected key -------------------------------------------------------
  {
    const { state, ready, exited } = startLogin(["--no-open", "--json"], env);
    await ready;
    await deliver(state.callback, { apiKey: "test-key-revoked", userName: "bad" });
    const code = await exited;
    check("login CLI fails when the upstream rejects the key", code === 1, `exit=${code}`);
    check("login CLI explains the rejection", /rejected|Invalid/i.test(state.stderr + state.stdout), (state.stderr + state.stdout).slice(-300));
  }

  // --- writes into a running relay ---------------------------------------
  {
    const masterKey = randomBytes(32).toString("base64");
    const dataFile = join(dir, "relay.json");
    const port = 19620 + Math.floor(Math.random() * 200);
    const relayBase = `http://127.0.0.1:${port}`;

    const relayChild = spawn(process.execPath, ["src/server.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        RELAY_PORT: String(port),
        RELAY_HOST: "127.0.0.1",
        RELAY_ADMIN_PASSWORD: "relay-password",
        RELAY_MASTER_KEY: masterKey,
        RELAY_DATA_FILE: dataFile,
        RELAY_UPSTREAM_BASE: upstream.base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let relayLog = "";
    relayChild.stdout.on("data", (d) => (relayLog += d.toString()));
    relayChild.stderr.on("data", (d) => (relayLog += d.toString()));

    const waitHealthy = async () => {
      for (let i = 0; i < 80; i += 1) {
        try {
          const r = await fetch(`${relayBase}/health`);
          if (r.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`relay did not start:
${relayLog}`);
    };

    try {
      await waitHealthy();

      const first = startLogin(
        ["--no-open", "--json", "--relay", relayBase, "--password", "relay-password", "--name", "written"],
        env,
      );
      await first.ready;
      await deliver(first.state.callback, { apiKey: "test-key-good", userName: "vialogin" });
      const code = await first.exited;
      check("login CLI --relay exits successfully", code === 0, `exit=${code} ${first.state.stderr}`);

      const login = await fetch(`${relayBase}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "relay-password" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const overview = await (await fetch(`${relayBase}/admin/api/overview`, { headers: { cookie } })).json();
      check(
        "login CLI --relay registers the account in the relay",
        overview.accounts.some((a) => a.name === "written"),
        JSON.stringify(overview.accounts.map((a) => a.name)),
      );

      const second = startLogin(
        ["--no-open", "--json", "--relay", relayBase, "--password", "wrong-password"],
        env,
      );
      await second.ready;
      await deliver(second.state.callback, { apiKey: "test-key-good", userName: "nope" });
      const secondCode = await second.exited;
      check("login CLI --relay fails on a wrong admin password", secondCode === 1, `exit=${secondCode}`);
      check(
        "login CLI still surfaces the key when the relay refuses",
        (second.state.stdout + second.state.stderr).includes("test-key-good"),
        (second.state.stdout + second.state.stderr).slice(-300),
      );
      const after = await (await fetch(`${relayBase}/admin/api/overview`, { headers: { cookie } })).json();
      check("a rejected submission adds no account", after.accounts.length === overview.accounts.length, `${after.accounts.length} vs ${overview.accounts.length}`);
    } finally {
      relayChild.kill("SIGTERM");
      await new Promise((r) => relayChild.once("exit", r));
    }
  }
} finally {
  await upstream.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} login-cli check(s) failed` : "\nlogin-cli checks ok");
if (failures) process.exitCode = 1;
