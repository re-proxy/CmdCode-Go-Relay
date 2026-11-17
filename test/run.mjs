import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startMockUpstream } from "./mock-upstream.mjs";

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    results.push(`  ✅ ${name}`);
  } else {
    failures += 1;
    results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready at ${url}`);
}

/** Runs a short-lived child to completion without blocking this process. */
function runChild(args, env, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.once("exit", (code) => finish({ status: code, stdout, stderr, timedOut: false }));
    child.once("error", () => finish({ status: null, stdout, stderr, timedOut: false }));
  });
}

async function collectSSE(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line) continue;
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          events.push({ data: JSON.parse(payload) });
        } catch {
          events.push({ raw: payload });
        }
      } else if (payload === "[DONE]") {
        events.push({ done: true });
      }
    } else if (line.startsWith("event:")) {
      const [eventLine, dataLine] = line.split("\n");
      const event = eventLine.slice(6).trim();
      const data = dataLine?.startsWith("data:") ? JSON.parse(dataLine.slice(5).trim()) : null;
      events.push({ event, data });
    }
  }
  return events;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "cmdcd-relay-test-"));
  const upstream = await startMockUpstream();
  const port = 18317 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const masterKey = randomBytes(32).toString("base64");

  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_HOST: "127.0.0.1",
      RELAY_ADMIN_PASSWORD: "test-password",
      RELAY_MASTER_KEY: masterKey,
      RELAY_DATA_FILE: join(dataDir, "relay.json"),
      RELAY_UPSTREAM_BASE: upstream.base,
      RELAY_MAX_CONCURRENT: "2",
      RELAY_ACCOUNT_QUEUE_MS: "8000",
      RELAY_PUBLIC_URL: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const cleanup = () => {
    try { child.kill("SIGTERM"); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitFor(`${base}/health`);

    // --- keygen entry point -------------------------------------------------
    {
      const { spawnSync } = await import("node:child_process");
      const out = spawnSync(process.execPath, ["src/server.mjs", "keygen"], {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RELAY_ADMIN_PASSWORD: "", RELAY_MASTER_KEY: "" },
      });
      check("keygen exits immediately", out.status === 0, `status=${out.status} signal=${out.signal}`);
      const key = (out.stdout ?? "").trim();
      check("keygen prints only a base64 key", /^[A-Za-z0-9+/]{43}=$/.test(key), JSON.stringify(key));
      check("keygen decodes to 32 bytes", Buffer.from(key, "base64").length === 32);
      check("keygen works without existing config", out.status === 0 && !/config:/.test(out.stderr ?? ""), out.stderr);
    }

    // --- unauthenticated protection -----------------------------------------
    {
      const res = await fetch(`${base}/v1/models`);
      check("GET /v1/models without a key is 401", res.status === 401, `got ${res.status}`);
    }
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      check("POST /v1/chat/completions without a key is 401", res.status === 401, `got ${res.status}`);
    }

    // --- admin auth ---------------------------------------------------------
    let cookie = "";
    {
      const res = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      check("admin login rejects a bad password", res.status === 401, `got ${res.status}`);
    }
    {
      const res = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      });
      const setCookie = res.headers.get("set-cookie") ?? "";
      cookie = setCookie.split(";")[0];
      check("admin login accepts the configured password", res.status === 200, `got ${res.status}`);
      check("admin login sets an HttpOnly session cookie", /HttpOnly/i.test(setCookie), setCookie);
    }
    const adminHeaders = { cookie, "content-type": "application/json" };

    {
      const res = await fetch(`${base}/admin/api/overview`);
      check("admin API rejects cookie-less requests", res.status === 401, `got ${res.status}`);
    }

    // --- add an account via the paste flow ---------------------------------
    {
      const res = await fetch(`${base}/admin/api/accounts`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ value: "test-key-good", name: "tester" }),
      });
      const body = await res.json();
      check("adding an account with a valid key succeeds", res.status === 200, JSON.stringify(body));
      check("account is recorded with a name", body.account?.name === "tester", JSON.stringify(body.account));
    }
    {
      const res = await fetch(`${base}/admin/api/accounts`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ value: "test-key-bad", name: "bad" }),
      });
      check("adding an account with an invalid key is rejected", res.status >= 400, `got ${res.status}`);
    }

    // --- create an API key --------------------------------------------------
    let apiKey = "";
    {
      const res = await fetch(`${base}/admin/api/keys`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: "test-client" }),
      });
      const body = await res.json();
      apiKey = body.key;
      check("creating an API key returns the secret once", Boolean(body.key), JSON.stringify(body));
      check("API key carries the relay prefix", String(body.key).startsWith("sk-cmd-"));
    }

    const authHeaders = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

    {
      const res = await fetch(`${base}/v1/models`, { headers: authHeaders });
      const body = await res.json();
      check("GET /v1/models lists the merged catalog", res.status === 200 && body.data.length === 3, JSON.stringify(body.data?.map?.((m) => m.id)));
      const flash = body.data.find((m) => m.id === "deepseek/deepseek-v4.1-flash");
      check("models carry context windows from the client catalog", flash?.context_length === 1000000, JSON.stringify(flash));
    }

    // --- non-streaming chat -------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
          ],
        }),
      });
      const body = await res.json();
      check("non-streaming chat returns 200", res.status === 200, JSON.stringify(body).slice(0, 300));
      check("non-streaming chat returns the text", body.choices?.[0]?.message?.content === "hello world", JSON.stringify(body));
      check("non-streaming chat reports usage", body.usage?.completion_tokens === 7, JSON.stringify(body.usage));
      check("non-streaming chat reports finish_reason", body.choices?.[0]?.finish_reason === "stop", JSON.stringify(body.choices));

      const upstreamRequest = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1);
      check("relay sends system prompt to the gateway", upstreamRequest?.body?.params?.system === "be brief", JSON.stringify(upstreamRequest?.body?.params?.system));
      check("relay sends the CLI version header", Boolean(upstreamRequest?.headers?.["x-command-code-version"]));
      check("relay forwards the account key", upstreamRequest?.headers?.authorization === "Bearer test-key-good");
    }

    // --- streaming chat -----------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      const events = await collectSSE(res);
      const chunks = events.filter((e) => e.data).map((e) => e.data);
      const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
      check("streaming chat returns SSE chunks", res.headers.get("content-type")?.includes("text/event-stream"), res.headers.get("content-type"));
      check("streaming chat assembles the full text", text === "hello world", JSON.stringify(text));
      check("streaming chat ends with [DONE]", events.some((e) => e.done));
      const usageChunk = chunks.find((c) => c.usage);
      check("streaming chat emits usage when asked", usageChunk?.usage?.completion_tokens === 7, JSON.stringify(usageChunk));
      const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);
      check("streaming chat emits finish_reason", finishChunk?.choices?.[0]?.finish_reason === "stop", JSON.stringify(finishChunk));
    }

    // --- tool calls ---------------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [{ role: "user", content: "USE_TOOL please" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
        }),
      });
      const body = await res.json();
      const call = body.choices?.[0]?.message?.tool_calls?.[0];
      check("tool calls are returned to the client", call?.function?.name === "get_weather", JSON.stringify(body).slice(0, 400));
      check("tool call arguments are JSON", (() => { try { JSON.parse(call.function.arguments); return true; } catch { return false; } })());
      check("tool call finish_reason is tool_calls", body.choices?.[0]?.finish_reason === "tool_calls");

      const upstreamRequest = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1);
      check("tools are forwarded in gateway schema", upstreamRequest?.body?.params?.tools?.[0]?.input_schema?.properties?.city?.type === "string", JSON.stringify(upstreamRequest?.body?.params?.tools));
    }

    // --- anthropic non-streaming -------------------------------------------
    {
      const res2 = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 256, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await res2.json();
      check("anthropic messages returns 200", res2.status === 200, JSON.stringify(body).slice(0, 300));
      const firstText = body.content?.find((c) => c.type === "text");
      check("anthropic messages returns text content", firstText?.text === "hello world", JSON.stringify(body.content));
      check("anthropic messages omits unrequested thinking", !body.content?.some((c) => c.type === "thinking"), JSON.stringify(body.content));
      check("anthropic messages reports stop_reason", body.stop_reason === "end_turn", JSON.stringify(body.stop_reason));
      check("anthropic messages reports usage", body.usage?.output_tokens === 7, JSON.stringify(body.usage));
    }

    // --- anthropic extended thinking when requested -------------------------
    {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 512,
          thinking: { type: "enabled", budget_tokens: 256 },
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const body = await res.json();
      check("anthropic returns a thinking block when asked", body.content?.[0]?.type === "thinking", JSON.stringify(body.content));
    }

    // --- anthropic streaming ------------------------------------------------
    {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 256, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      const events = await collectSSE(res);
      const names = events.map((e) => e.event).filter(Boolean);
      check("anthropic stream emits message_start", names.includes("message_start"), names.join(","));
      check("anthropic stream emits content_block_delta", names.includes("content_block_delta"), names.join(","));
      check("anthropic stream emits message_stop", names.includes("message_stop"), names.join(","));
      const text = events.filter((e) => e.event === "content_block_delta").map((e) => e.data?.delta?.text ?? "").join("");
      check("anthropic stream assembles the text", text.includes("hello"), JSON.stringify(text));
    }

    // --- anthropic tool use -------------------------------------------------
    {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 256,
          messages: [{ role: "user", content: "USE_TOOL" }],
          tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
        }),
      });
      const body = await res.json();
      const toolUse = body.content?.find((c) => c.type === "tool_use");
      check("anthropic tool_use block is returned", toolUse?.name === "get_weather", JSON.stringify(body.content));
      check("anthropic stop_reason is tool_use", body.stop_reason === "tool_use", body.stop_reason);
    }

    // --- upstream errors ----------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "TRIGGER_ERROR" }] }),
      });
      const body = await res.json();
      check("upstream errors are surfaced with a status", res.status === 403, `got ${res.status}`);
      check("upstream errors keep the message", /premium_credits_exhausted/.test(body.error?.message ?? ""), JSON.stringify(body));
    }

    // --- mid-stream failure -------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [{ role: "user", content: "TRIGGER_MID_ERROR" }],
          stream: true,
        }),
      });
      const events = await collectSSE(res);
      const chunks = events.filter((e) => e.data).map((e) => e.data);
      check("a mid-stream failure is reported as an error frame", chunks.some((c) => c.error), JSON.stringify(chunks).slice(0, 300));
      check("a mid-stream failure still terminates the stream", events.some((e) => e.done), JSON.stringify(events).slice(0, 200));
      const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
      check("partial text before the failure is preserved", text === "hello ", JSON.stringify(text));
      const res2 = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [{ role: "user", content: "TRIGGER_MID_ERROR" }],
        }),
      });
      const body = await res2.json();
      check("a non-streaming mid-stream failure is a 500/502", res2.status >= 500, `got ${res2.status}`);
      check("a non-streaming mid-stream failure has an error body", Boolean(body.error), JSON.stringify(body));
    }

    // --- multi-turn tool conversation ---------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } }],
            },
            { role: "tool", tool_call_id: "call_9", content: "22C" },
            { role: "user", content: "and tomorrow?" },
          ],
          tools: [
            { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
          ],
        }),
      });
      check("a multi-turn tool conversation succeeds", res.status === 200, `got ${res.status}`);
      const sent = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1)?.body?.params?.messages ?? [];
      const assistant = sent.find((m) => m.role === "assistant");
      const toolMsg = sent.find((m) => m.role === "tool");
      check("assistant tool calls are replayed to the gateway", assistant?.content?.some((c) => c.type === "tool-call" && c.toolCallId === "call_9"), JSON.stringify(sent));
      check("tool results keep their call id and name", toolMsg?.content?.[0]?.toolCallId === "call_9" && toolMsg?.content?.[0]?.toolName === "get_weather", JSON.stringify(toolMsg));
      check("tool results carry the text output", toolMsg?.content?.[0]?.output?.value === "22C", JSON.stringify(toolMsg));
      const roles = sent.map((m) => m.role);
      check("same-role neighbours are merged for the gateway", roles.join(",") === "user,assistant,tool,user", roles.join(","));
    }

    // --- client-only models -------------------------------------------------
    {
      const listing = await (await fetch(`${base}/v1/models`, { headers: authHeaders })).json();
      const free = listing.data.find((m) => m.id === "MiniMaxAI/MiniMax-M3-Free");
      check("models the CLI catalog adds are offered", Boolean(free), JSON.stringify(listing.data.map((m) => m.id)));
      check("client-only models keep their pricing", free?.pricing?.inputCost === 0.3, JSON.stringify(free));

      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "MiniMaxAI/MiniMax-M3-Free", messages: [{ role: "user", content: "hi" }] }),
      });
      check("a client-only model is accepted for generation", res.status === 200, `got ${res.status}`);

      const viaAlias = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "minimax-m3-free", messages: [{ role: "user", content: "hi" }] }),
      });
      check("declared aliases resolve to their model", viaAlias.status === 200, `got ${viaAlias.status}`);
      const sent = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1);
      check("aliases are forwarded as the canonical id", sent?.body?.params?.model === "MiniMaxAI/MiniMax-M3-Free", sent?.body?.params?.model);
    }

    // --- Responses API ------------------------------------------------------
    {
      const res = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          instructions: "be brief",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        }),
      });
      const body = await res.json();
      check("responses returns 200", res.status === 200, JSON.stringify(body).slice(0, 300));
      check("responses object is type response", body.object === "response", body.object);
      check("responses reports completed", body.status === "completed", body.status);
      check("responses exposes output_text", body.output_text === "hello world", JSON.stringify(body.output_text));
      const message = body.output?.find((i) => i.type === "message");
      check("responses output contains an output_text part", message?.content?.[0]?.type === "output_text", JSON.stringify(body.output));
      check("responses reports usage from the gateway", body.usage?.output_tokens === 7, JSON.stringify(body.usage));
      const sent = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1);
      check("responses forwards instructions as the system prompt", sent?.body?.params?.system === "be brief", sent?.body?.params?.system);
    }

    {
      const res = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          input: "USE_TOOL",
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        }),
      });
      const body = await res.json();
      const call = body.output?.find((i) => i.type === "function_call");
      check("responses returns function_call items", call?.name === "get_weather", JSON.stringify(body.output));
      check("function_call arguments are JSON text", (() => { try { JSON.parse(call.arguments); return true; } catch { return false; } })());
    }

    {
      const res = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "deepseek/deepseek-v4.1-flash",
          input: [
            { role: "user", content: "weather?" },
            { type: "function_call", call_id: "call_7", name: "get_weather", arguments: '{"city":"Beijing"}' },
            { type: "function_call_output", call_id: "call_7", output: "22C" },
          ],
        }),
      });
      check("responses accepts a tool round-trip", res.status === 200, `got ${res.status}`);
      const sent = upstream.requests.filter((r) => r.path === "/alpha/generate").at(-1)?.body?.params?.messages ?? [];
      const toolMsg = sent.find((m) => m.role === "tool");
      check("function_call_output becomes a tool-result", toolMsg?.content?.[0]?.toolCallId === "call_7", JSON.stringify(sent));
    }

    {
      const res = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", input: "hi", stream: true }),
      });
      const events = await collectSSE(res);
      const names = events.map((e) => e.event).filter(Boolean);
      check("responses stream emits response.created", names.includes("response.created"), names.join(","));
      check("responses stream emits output_text.delta", names.includes("response.output_text.delta"), names.join(","));
      check("responses stream terminates with response.completed", names.includes("response.completed"), names.join(","));
      const deltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta ?? "").join("");
      check("responses stream assembles the text", deltas === "hello world", JSON.stringify(deltas));
      const final = events.find((e) => e.event === "response.completed")?.data?.response;
      check("response.completed carries the full object", final?.output_text === "hello world" && final.status === "completed", JSON.stringify(final?.status));
      const seqs = events.filter((e) => e.data?.sequence_number !== undefined).map((e) => e.data.sequence_number);
      check("responses stream numbers its events", seqs.length > 0 && seqs.every((n, i) => n === i), JSON.stringify(seqs));
    }

    {
      const res = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", input: "TRIGGER_ERROR" }),
      });
      const body = await res.json();
      check("responses surfaces upstream errors", res.status === 403 && Boolean(body.error), `${res.status} ${JSON.stringify(body)}`);
    }

    // --- rejected credentials park the account ------------------------------
    {
      const res = await fetch(`${base}/admin/api/accounts`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ value: "test-key-revoked", name: "revoked" }),
      });
      check("a key rejected by whoami is not stored", res.status === 401, `got ${res.status}`);

      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      check("no parked account was created by a rejected key", !overview.accounts.some((a) => a.name === "revoked"), JSON.stringify(overview.accounts.map((a) => a.name)));
    }

    // --- clearing the parked flag ------------------------------------------
    {
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      const any = overview.accounts[0];
      const res = await fetch(`${base}/admin/api/accounts/${any.id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ clearReauth: true, enabled: true }),
      });
      const body = await res.json();
      check("clearReauth is accepted", res.status === 200, `got ${res.status}`);
      check("clearReauth leaves the account usable", body.account?.needsReauth === false, JSON.stringify(body.account?.needsReauth));
    }

    // --- malformed admin calls are the caller's fault, not a 500 -----------
    {
      const res = await fetch(`${base}/admin/api/accounts`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({}),
      });
      const body = await res.json();
      check("an empty account submission is a 400", res.status === 400, `got ${res.status}`);
      check("the validation message is preserved", /API key/i.test(body.error?.message ?? ""), JSON.stringify(body));
      check("every error carries a request id for log matching", /^[0-9a-f]{8}$/.test(body.error?.request_id ?? ""), JSON.stringify(body.error));
    }
    {
      const res = await fetch(`${base}/admin/api/accounts/credits`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({}),
      });
      check("credits without an account id is a 400", res.status === 400, `got ${res.status}`);
    }

    // --- unknown model ------------------------------------------------------
    {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "not-a-model", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await res.json();
      check("unknown models are rejected with 404", res.status === 404, `got ${res.status}`);
      check("unknown model error lists alternatives", /deepseek/.test(body.error?.message ?? ""), JSON.stringify(body));
    }

    // --- balance ------------------------------------------------------------
    {
      const res = await fetch(`${base}/v1/balance`, { headers: authHeaders });
      const body = await res.json();
      check("balance endpoint returns credits", res.status === 200 && body.balance === 5.5, JSON.stringify(body));
      check("balance endpoint marks completeness", body.complete === true, JSON.stringify(body));
      check("balance lists per-account detail", body.accounts?.[0]?.plan_id === "individual-go", JSON.stringify(body.accounts));
      const before = upstream.requests.filter((r) => r.path.startsWith("/alpha/billing")).length;
      await fetch(`${base}/v1/balance`, { headers: authHeaders });
      const afterCalls = upstream.requests.filter((r) => r.path.startsWith("/alpha/billing")).length;
      check("balance is cached between polls", afterCalls === before, `${before} -> ${afterCalls}`);
    }

    // --- usage + overview ---------------------------------------------------
    {
      const res = await fetch(`${base}/admin/api/overview`, { headers: adminHeaders });
      const body = await res.json();
      check("overview reports recorded usage", body.usage.length > 0, String(body.usage.length));
      check("overview counts failures", body.usage.some((u) => !u.ok));
      check("overview lists the API key", body.apiKeys.length === 1);
      const account = body.accounts[0];
      check("account was marked used", Boolean(account.lastUsedAt));
    }

    // --- login broker -------------------------------------------------------
    {
      const res = await fetch(`${base}/admin/api/accounts/login-url`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({}),
      });
      const body = await res.json();
      check("login-url returns an official login URL", /\/studio\/auth\/cli\?/.test(body.url ?? ""), JSON.stringify(body));
      check("login-url points the callback at the relay", String(body.url).includes(encodeURIComponent(`${base}/callback`)), body.url);
      check("login-url carries a state token", /state=[A-Za-z0-9_-]{10,}/.test(body.url ?? ""), body.url);
      check("a loopback console gets the automatic handoff", body.mode === "automatic", body.mode);
    }

    // --- the consent page only accepts loopback callbacks -------------------
    {
      // Command Code rejects any non-loopback callback before the user can
      // approve, so a LAN or public console must never be offered one.
      for (const origin of ["http://192.168.1.10:8317", "https://relay.example.com"]) {
        const res = await fetch(`${base}/admin/api/accounts/login-url`, {
          method: "POST",
          headers: { ...adminHeaders, "x-forwarded-proto": origin.split(":")[0], "x-forwarded-host": origin.replace(/^https?:\/\//, "") },
          body: JSON.stringify({}),
        });
        const body = await res.json();
        const callback = new URL(body.callback);
        check(`callback stays loopback for console ${origin}`, ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname), body.callback);
        check(`console ${origin} is told the handoff is manual`, body.mode === "manual", body.mode);
        check(
          `the login URL embeds only the loopback callback for ${origin}`,
          !String(body.url).includes(encodeURIComponent(origin.split("://")[1])),
          body.url,
        );
      }
    }
    {
      const res = await fetch(`${base}/callback?apiKey=test-key-good&state=abc&userName=viacallback&userId=u_9`, {
        redirect: "manual",
      });
      check("callback accepts the official redirect shape", res.status === 303, `got ${res.status}`);
      check("callback redirects to the completion page", (res.headers.get("location") ?? "").includes("/callback/complete"), res.headers.get("location") ?? "");
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      check("callback registered a second account", overview.accounts.length === 2, JSON.stringify(overview.accounts.map((a) => a.name)));
    }
    {
      // The consent page delivers the key by cross-origin POST, not a query.
      const form = new URLSearchParams({ apiKey: "test-key-good", state: "abc", userName: "viaform", userId: "u_f" });
      const res = await fetch(`${base}/callback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://commandcode.ai" },
        body: form.toString(),
        redirect: "manual",
      });
      check("callback accepts an urlencoded POST", res.status === 303, `got ${res.status}`);
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      check("a POSTed credential becomes an account", overview.accounts.some((a) => a.name === "viaform"), JSON.stringify(overview.accounts.map((a) => a.name)));

      const json = await fetch(`${base}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://commandcode.ai" },
        body: JSON.stringify({ apiKey: "test-key-good", state: "abc", userName: "viajson" }),
        redirect: "manual",
      });
      // Matches the official CLI: a JSON callback gets a JSON acknowledgement.
      check("callback accepts a JSON POST", json.status === 200, `got ${json.status}`);
      const jsonBody = await json.json().catch(() => ({}));
      check("a JSON callback is acknowledged like the CLI does", jsonBody.success === true, JSON.stringify(jsonBody));
    }
    {
      // Chrome blocks public-origin -> loopback requests without this opt-in.
      const preflight = await fetch(`${base}/callback`, {
        method: "OPTIONS",
        headers: {
          origin: "https://commandcode.ai",
          "access-control-request-method": "POST",
          "access-control-request-private-network": "true",
        },
      });
      check("callback preflight is allowed", preflight.status === 204, `got ${preflight.status}`);
      check("callback preflight grants private network access", preflight.headers.get("access-control-allow-private-network") === "true", preflight.headers.get("access-control-allow-private-network"));
    }
    {
      const res = await fetch(`${base}/callback/complete?state=abc`);
      check("callback completion page renders", res.status === 200 && /登录/.test(await res.text()));
    }
    {
      const res = await fetch(`${base}/callback?error=access_denied`);
      check("callback surfaces a denied login", res.status === 400, `got ${res.status}`);
    }

    // --- concurrency gate ---------------------------------------------------
    {
      const before = upstream.requests.filter((r) => r.path === "/alpha/generate").length;
      const requests = Array.from({ length: 4 }, () =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
        }).then((r) => r.status),
      );
      const statuses = await Promise.all(requests);
      check("concurrent requests all succeed", statuses.every((s) => s === 200), JSON.stringify(statuses));
      const after = upstream.requests.filter((r) => r.path === "/alpha/generate").length;
      check("concurrent requests reach the upstream", after - before === 4, String(after - before));
    }

    // --- concurrency gate actually bounds upstream calls --------------------
    {
      const enabledBefore = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      const enabledCount = enabledBefore.accounts.filter((a) => a.enabled && !a.needsReauth).length;
      upstream.resetPeak();
      const requests = Array.from({ length: 6 }, () =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "SLOW" }] }),
        }).then((r) => r.status),
      );
      const statuses = await Promise.all(requests);
      check("queued requests all complete", statuses.every((s) => s === 200), JSON.stringify(statuses));
      check("the slow request path actually reached the upstream", upstream.peak() > 0, `peak=${upstream.peak()}`);
      check(
        "upstream concurrency never exceeds RELAY_MAX_CONCURRENT per account",
        upstream.peak() <= enabledCount * 2,
        `peak=${upstream.peak()} (${enabledCount} accounts x limit 2)`,
      );
    }

    // --- no enabled account -------------------------------------------------
    {
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      for (const account of overview.accounts) {
        await fetch(`${base}/admin/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ enabled: false }),
        });
      }
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await res.json();
      check("no enabled account returns 503", res.status === 503, `got ${res.status}`);
      check("no enabled account names the reason", body.error?.code === "no_enabled_account", JSON.stringify(body));
      // Re-enable for the restart checks below.
      for (const account of overview.accounts) {
        await fetch(`${base}/admin/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ enabled: true }),
        });
      }
    }

    // --- key lifecycle ------------------------------------------------------
    {
      const res = await fetch(`${base}/admin/api/keys/enabled`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ id: (await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json()).apiKeys[0].id, enabled: false }),
      });
      check("disabling an API key succeeds", res.status === 200);
      const chat = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
      });
      check("a disabled key is rejected", chat.status === 401, `got ${chat.status}`);
    }

    // --- CORS scope ---------------------------------------------------------
    {
      const api = await fetch(`${base}/v1/models`, {
        headers: { ...authHeaders, origin: "https://evil.example" },
      });
      check("API responses allow cross-origin clients", api.headers.get("access-control-allow-origin") === "https://evil.example", api.headers.get("access-control-allow-origin"));
      const overviewRes = await fetch(`${base}/admin/api/overview`, {
        headers: { cookie, origin: "https://evil.example" },
      });
      check("admin responses carry no CORS grant", overviewRes.headers.get("access-control-allow-origin") === null, overviewRes.headers.get("access-control-allow-origin"));
      const preflight = await fetch(`${base}/admin/api/overview`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      check("admin preflight is not answered as CORS", preflight.status !== 204, `got ${preflight.status}`);
    }

    // --- admin page ---------------------------------------------------------
    {
      const res = await fetch(`${base}/`);
      const html = await res.text();
      check("admin page is served at /", res.status === 200 && html.includes("Command Code Relay"), String(res.status));
      check("admin page embeds the boot state", html.includes("window.__BOOT__"));
      check("admin page is server-rendered without the password", !html.includes("test-password"));
    }

    // --- persistence across restart -----------------------------------------
    {
      const beforeRestart = await (await fetch(`${base}/admin/api/overview`, { headers: adminHeaders })).json();
      const expectedAccounts = beforeRestart.accounts.length;
      const expectedKeys = beforeRestart.apiKeys.length;
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      const restarted = spawn(process.execPath, ["src/server.mjs"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          RELAY_PORT: String(port),
          RELAY_HOST: "127.0.0.1",
          RELAY_ADMIN_PASSWORD: "test-password",
          RELAY_MASTER_KEY: masterKey,
          RELAY_DATA_FILE: join(dataDir, "relay.json"),
          RELAY_UPSTREAM_BASE: upstream.base,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitFor(`${base}/health`);
      const res = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      });
      const newCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: { cookie: newCookie } })).json();
      check("accounts survive a restart", overview.accounts.length === expectedAccounts, `${overview.accounts.length} vs ${expectedAccounts}`);
      check("api keys survive a restart", overview.apiKeys.length === expectedKeys, `${overview.apiKeys.length} vs ${expectedKeys}`);
      restarted.kill("SIGTERM");
      await new Promise((r) => restarted.once("exit", r));
    }

    // --- doctor subcommand --------------------------------------------------
    {
      const common = {
        RELAY_ADMIN_PASSWORD: "test-password",
        RELAY_MASTER_KEY: masterKey,
        RELAY_UPSTREAM_BASE: upstream.base,
      };
      const clean = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_DATA_FILE: join(dataDir, "relay.json"),
      });
      const out = clean.stdout;
      check("doctor runs and reports every section", /configuration[\s\S]*storage[\s\S]*upstream[\s\S]*accounts[\s\S]*api keys/.test(out), out.slice(0, 300));
      check("doctor passes on a healthy deployment", clean.status === 0, `status=${clean.status} timedOut=${clean.timedOut} ${out.slice(-200)}`);
      check("doctor resolves the catalog through the configured upstream", /model catalog reachable/.test(out), out.slice(0, 300));
      check("doctor never prints a stored credential", !out.includes("test-key-good") && !out.includes("sk-"), out.slice(0, 300));

      const empty = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_DATA_FILE: join(dataDir, "unconfigured.json"),
      });
      check("doctor warns rather than fails on an unconfigured instance", empty.status === 0, `status=${empty.status}`);
      check("doctor says what is missing", /no accounts yet/.test(empty.stdout), empty.stdout.slice(-300));

      const badKey = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_MASTER_KEY: "not-valid",
        RELAY_DATA_FILE: join(dataDir, "relay.json"),
      });
      check("doctor fails on a wrong master key", badKey.status === 1, `status=${badKey.status}`);
      check("doctor explains the master key problem", /32 bytes/.test(badKey.stdout), badKey.stdout.slice(0, 400));

      const badCallback = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_DATA_FILE: join(dataDir, "relay.json"),
        RELAY_LOGIN_CALLBACK: "https://relay.example.com",
      });
      check("doctor rejects a non-loopback login callback", badCallback.status === 1, `status=${badCallback.status}`);
      check("doctor explains the loopback-only rule", /only accepts 127\.0\.0\.1/.test(badCallback.stdout), badCallback.stdout.slice(0, 500));

      const goodCallback = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_DATA_FILE: join(dataDir, "relay.json"),
        RELAY_LOGIN_CALLBACK: "http://127.0.0.1:9000",
      });
      check("doctor accepts a loopback login callback", goodCallback.status === 0, `status=${goodCallback.status}`);

      const deadUpstream = await runChild(["src/server.mjs", "doctor"], {
        ...common,
        RELAY_UPSTREAM_BASE: "http://127.0.0.1:1",
        RELAY_DATA_FILE: join(dataDir, "relay.json"),
      });
      check("doctor reports an unreachable upstream", deadUpstream.status === 1, `status=${deadUpstream.status}`);
      check("doctor names the unreachable dependency", /catalog unreachable/.test(deadUpstream.stdout), deadUpstream.stdout.slice(0, 400));
    }

    // --- out-of-date CLI version -------------------------------------------
    {
      const stale = spawn(process.execPath, ["src/server.mjs"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          RELAY_PORT: String(port),
          RELAY_HOST: "127.0.0.1",
          RELAY_ADMIN_PASSWORD: "test-password",
          RELAY_MASTER_KEY: masterKey,
          RELAY_DATA_FILE: join(dataDir, "relay.json"),
          RELAY_UPSTREAM_BASE: upstream.base,
          RELAY_CLI_VERSION: "0.0.1",
          RELAY_PUBLIC_URL: base,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitFor(`${base}/health`);
      const relogin = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      });
      const staleCookie = (relogin.headers.get("set-cookie") ?? "").split(";")[0];
      const overview = await (await fetch(`${base}/admin/api/overview`, { headers: { cookie: staleCookie } })).json();
      for (const account of overview.accounts) {
        await fetch(`${base}/admin/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: { cookie: staleCookie, "content-type": "application/json" },
          body: JSON.stringify({ clearReauth: true, enabled: true }),
        });
      }
      const keyRes = await fetch(`${base}/admin/api/keys`, {
        method: "POST",
        headers: { cookie: staleCookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "stale" }),
      });
      const staleKey = (await keyRes.json()).key;
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${staleKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await res.json();
      check("an outdated CLI version is reported clearly", res.status === 502, `got ${res.status}`);
      check("the upgrade error names the required version", /9\.9\.9/.test(body.error?.message ?? ""), body.error?.message);
      check("the upgrade error names the setting to change", /RELAY_CLI_VERSION/.test(body.error?.message ?? ""), body.error?.message);
      stale.kill("SIGTERM");
      await new Promise((r) => stale.once("exit", r));
    }

  } finally {
    cleanup();
    await upstream.close();
  }

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    if (stdout.trim()) console.log("\n--- server stdout ---\n" + stdout.trim());
    if (stderr.trim()) console.log("\n--- server stderr ---\n" + stderr.trim());
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
