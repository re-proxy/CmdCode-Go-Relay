import http from "node:http";
import { randomUUID } from "node:crypto";
import { config, validateConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { AccountPool } from "./pool.mjs";
import { Relay } from "./relay.mjs";
import { fetchCredits, listModels } from "./upstream.mjs";
import { summarizeCredits } from "./credits.mjs";
import {
  messagesFromAnthropic,
  messagesFromOpenAI,
  toolsFromAnthropic,
  toolsFromOpenAI,
} from "./wire.mjs";
import {
  HttpError,
  anthropicError,
  anthropicMaxOutputTokens,
  anthropicMessageDelta,
  anthropicMessageStart,
  collectOpenAI,
  openAIUsage,
  openaiError,
  sseEvent,
  streamOpenAIChat,
} from "./convert.mjs";
import {
  buildResponseObject,
  maxOutputTokensFromResponses,
  messagesFromResponses,
  reasoningEffortFromResponses,
  responsesError,
  toolsFromResponses,
  writeResponseStream,
} from "./responses.mjs";
import { adminRouter } from "./admin.mjs";
import { createLoginBroker } from "./login.mjs";

// Subcommands run before config validation so they can help when config is the
// problem.
const subcommand = process.argv[2];

// `keygen` prints a fresh master key and exits, so the container can generate
// one without a data volume.
if (subcommand === "keygen") {
  const { randomBytes } = await import("node:crypto");
  process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
  process.exit(0);
}

// `doctor` diagnoses a deployment: config, storage, upstream, accounts, keys.
if (subcommand === "doctor") {
  const { doctor } = await import("./doctor.mjs");
  process.exit(await doctor());
}

const problems = validateConfig();
if (problems.length) {
  for (const problem of problems) console.error(`config: ${problem}`);
  console.error("Set the missing values in .env (see .env.example) and restart.");
  console.error("Or run `node src/server.mjs doctor` after fixing them.");
  process.exit(1);
}

const store = new Store();
const pool = new AccountPool(store);
const relay = new Relay(store);
relay.pool = pool;
const loginBroker = createLoginBroker({ store });

// --------------------------------------------------------------------- utils

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new HttpError(413, "Request body too large", { code: "payload_too_large" });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON", { code: "invalid_json" });
  }
}

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();
  return null;
}

function requireApiKey(req) {
  const secret = bearerFrom(req);
  if (!secret) {
    throw new HttpError(401, "Missing API key", { code: "missing_api_key" });
  }
  const record = store.findApiKeyBySecret(secret);
  if (!record) {
    throw new HttpError(401, "Invalid or disabled API key", { code: "invalid_api_key" });
  }
  return record;
}

/** Origin the browser actually used, ignoring RELAY_PUBLIC_URL. */
function requestOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "127.0.0.1:8317")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

/** Origin used for display and client snippets; honours RELAY_PUBLIC_URL. */
function clientOrigin(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  return requestOrigin(req);
}

function isAdminPath(path) {
  return path.startsWith("/admin") || path === "/" || path === "/index.html";
}

// ------------------------------------------------------------------- routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // CORS is for API clients only. The admin console is same-origin and is
  // deliberately left out, so a hostile page cannot ride its session cookie.
  if (!isAdminPath(path)) {
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    // The consent page lives on a public origin and posts to this loopback
    // callback, which Chrome treats as a private-network request.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("access-control-allow-private-network", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  try {
    if (path === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    if (path === "/callback" || path === "/callback/complete") {
      await loginBroker.handleCallback(req, res, url, clientOrigin(req));
      return;
    }

    if (path === "/v1/models" && req.method === "GET") {
      requireApiKey(req);
      const models = await listModels();
      json(res, 200, {
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: m.created,
          owned_by: m.owned_by,
          name: m.name,
          context_length: m.context_length,
          max_output_tokens: m.maxOutputTokens,
          reasoning_efforts: m.reasoningEfforts,
          input_modalities: m.inputModalities,
          pricing: m.pricing,
          supported_endpoints: m.supported_endpoints,
          minimum_plan: m.minimumPlan,
          category: m.category,
          aliases: m.aliases ?? [],
          hidden: m.hidden === true,
        })),
      });
      return;
    }

    if (path === "/v1/balance" && req.method === "GET") {
      requireApiKey(req);
      json(res, 200, await balanceSnapshot());
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const keyRecord = requireApiKey(req);
      await handleOpenAIChat(req, res, keyRecord);
      return;
    }

    if (path === "/v1/messages" && req.method === "POST") {
      const keyRecord = requireApiKey(req);
      await handleAnthropicMessages(req, res, keyRecord);
      return;
    }

    if (path === "/v1/responses" && req.method === "POST") {
      const keyRecord = requireApiKey(req);
      await handleResponses(req, res, keyRecord);
      return;
    }

    if (path.startsWith("/admin") || path === "/" || path === "/index.html") {
      await adminRouter({ req, res, url, path, store, relay, pool, loginBroker, clientOrigin, requestOrigin });
      return;
    }

    json(res, 404, { error: { message: `No route for ${req.method} ${path}` } });
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    const shape = path.startsWith("/v1/messages")
      ? anthropicError
      : path.startsWith("/v1/responses")
        ? responsesError
        : openaiError;
    const { status, body } = shape(error);
    json(res, status, body);
  }
});

// -------------------------------------------------------- Responses handler

async function handleResponses(req, res, keyRecord) {
  const body = await readJsonBody(req);
  if (!body?.model) throw new HttpError(400, "`model` is required", { code: "missing_model" });
  const hasInput = Array.isArray(body.input) || typeof body.input === "string";
  if (!hasInput && !Array.isArray(body.messages)) {
    throw new HttpError(400, "`input` must be a string or an array", { code: "invalid_input" });
  }

  const { messages, system } = messagesFromResponses(body);
  const prepared = await relay.prepare({
    model: body.model,
    messages,
    tools: toolsFromResponses(body.tools),
    system,
    maxTokens: maxOutputTokensFromResponses(body),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    reasoningEffort: reasoningEffortFromResponses(body),
    signal: abortSignal(res),
    source: "responses",
    apiKeyId: keyRecord.id,
  });

  store.touchApiKey(keyRecord.id);
  const id = `resp_${prepared.requestId.replace(/-/g, "").slice(0, 24)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  await prepared.ready();

  try {
    if (body.stream === true) {
      await writeResponseStream(res, {
        id,
        model: prepared.model,
        createdAt,
        events: prepared.events,
      });
      return;
    }

    const collected = [];
    await prepared.events((event) => collected.push(event));
    json(res, 200, buildResponseObject({ id, model: prepared.model, createdAt, events: collected }));
  } finally {
    prepared.release();
  }
}

// ------------------------------------------------------------------ balance

/**
 * Credits for every enabled account, cached for a minute. Downstream routers
 * poll this, so it must not turn into one upstream call per poll.
 */
const BALANCE_TTL_MS = 60 * 1000;
let balanceCache = { at: 0, body: null };

async function balanceSnapshot() {
  if (balanceCache.body && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.body;
  }

  const accounts = store.listAccounts().filter((a) => a.enabled);
  const details = await Promise.all(
    accounts.map(async (account) => {
      try {
        const credential = store.getAccountCredential(account.id);
        const raw = await fetchCredits(credential, store.getAccount(account.id)?.orgId ?? null);
        const summary = summarizeCredits(raw);
        if (!summary.available) {
          return { account: account.name, error: summary.errors.join("; ") || "no billing data" };
        }
        return {
          account: account.name,
          plan_id: summary.planId,
          status: summary.status,
          monthly: summary.monthlyCredits,
          purchased: summary.purchasedCredits,
          free: summary.freeCredits,
          balance: summary.totalCredits,
          current_period_end: summary.currentPeriodEnd,
        };
      } catch (error) {
        return { account: account.name, error: error?.message ?? String(error) };
      }
    }),
  );

  const ok = details.filter((d) => typeof d.balance === "number");
  const body = {
    balance: ok.length ? ok.reduce((sum, d) => sum + d.balance, 0) : null,
    unit: "credits",
    currency: "USD",
    complete: accounts.length > 0 && ok.length === accounts.length,
    accounts: details,
  };
  balanceCache = { at: Date.now(), body };
  return body;
}

// ------------------------------------------------------------ OpenAI handler

async function handleOpenAIChat(req, res, keyRecord, presetBody) {
  const body = presetBody ?? (await readJsonBody(req));
  if (!body?.model) throw new HttpError(400, "`model` is required", { code: "missing_model" });
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "`messages` must be an array", { code: "invalid_messages" });
  }

  const { messages, system } = messagesFromOpenAI(body.messages);
  const tools = toolsFromOpenAI(body.tools);
  const effort = normalizeEffort(body.reasoning_effort ?? body.reasoning?.effort);
  const stream = body.stream === true;

  const prepared = await relay.prepare({
    model: body.model,
    messages,
    tools,
    system,
    maxTokens: clampMaxTokens(body.max_completion_tokens ?? body.max_tokens),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    reasoningEffort: effort,
    signal: abortSignal(res),
    source: "openai",
    apiKeyId: keyRecord.id,
  });

  store.touchApiKey(keyRecord.id);
  const id = `chatcmpl-${prepared.requestId.replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Acquire the account before any bytes go out, so pool and model failures
  // still produce a proper HTTP status instead of a truncated stream.
  await prepared.ready();

  try {
    if (stream) {
      const includeUsage = body.stream_options?.include_usage === true;
      await streamOpenAIChat(res, {
        id,
        model: prepared.model,
        created,
        events: prepared.events,
        includeUsage,
      });
      return;
    }

    const collected = await collectOpenAI(prepared.events);
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: prepared.model,
      choices: [
        {
          index: 0,
          message: collected.message,
          finish_reason:
            collected.finishReason === "tool_calls"
              ? "tool_calls"
              : collected.finishReason === "length"
                ? "length"
                : "stop",
        },
      ],
      usage: openAIUsage(collected.usage),
    });
  } finally {
    prepared.release();
  }
}

// -------------------------------------------------------- Anthropic handler

async function handleAnthropicMessages(req, res, keyRecord) {
  const body = await readJsonBody(req);
  if (!body?.model) throw new HttpError(400, "`model` is required", { code: "missing_model" });
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "`messages` must be an array", { code: "invalid_messages" });
  }

  const { messages, system } = messagesFromAnthropic(body);
  const tools = toolsFromAnthropic(body.tools);
  const stream = body.stream === true;
  const effort = normalizeEffort(body.output_config?.effort ?? body.metadata?.effort);
  // Clients only understand extended thinking when they asked for it; an
  // unrequested `thinking` block with an empty signature is rejected by them.
  const wantsThinking = body.thinking?.type === "enabled" || body.thinking?.type === "adaptive";

  const prepared = await relay.prepare({
    model: body.model,
    messages,
    tools,
    system,
    maxTokens: anthropicMaxOutputTokens(body.max_tokens),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    reasoningEffort: effort,
    signal: abortSignal(res),
    source: "anthropic",
    apiKeyId: keyRecord.id,
  });

  store.touchApiKey(keyRecord.id);
  const id = `msg_${prepared.requestId.replace(/-/g, "").slice(0, 24)}`;

  await prepared.ready();

  try {
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      anthropicMessageStart(res, { id, model: prepared.model, usage: null });

      let index = -1;
      let open = null; // "text" | "thinking" | null
      let usage = null;
      let finishReason = "stop";

      const closeBlock = () => {
        if (!open) return;
        sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
        open = null;
      };
      const openBlock = (block) => {
        closeBlock();
        index += 1;
        sseEvent(res, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: block,
        });
        open = block.type;
      };

      await prepared.events((event) => {
        switch (event.type) {
          case "text": {
            if (open !== "text") openBlock({ type: "text", text: "" });
            sseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: event.text },
            });
            break;
          }
          case "reasoning": {
            if (!wantsThinking) break;
            if (open !== "thinking") openBlock({ type: "thinking", thinking: "", signature: "" });
            sseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: event.text },
            });
            break;
          }
          case "tool_call": {
            closeBlock();
            index += 1;
            sseEvent(res, "content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: event.id || `toolu_${randomUUID().slice(0, 16)}`,
                name: event.name,
                input: {},
              },
            });
            sseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(event.input ?? {}),
              },
            });
            sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
            break;
          }
          case "finish": {
            usage = event.usage;
            finishReason = event.finishReason;
            break;
          }
          default:
            break;
        }
      });

      closeBlock();
      if (index < 0) {
        // Nothing streamed: still emit one (empty) text block so the message is valid.
        openBlock({ type: "text", text: "" });
        closeBlock();
      }
      anthropicMessageDelta(res, { finishReason, usage });
      sseEvent(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }

    let text = "";
    let reasoning = "";
    const toolUses = [];
    let usage = null;
    let finishReason = "stop";

    await prepared.events((event) => {
      switch (event.type) {
        case "text":
          text += event.text;
          break;
        case "reasoning":
          reasoning += event.text;
          break;
        case "tool_call":
          toolUses.push({
            type: "tool_use",
            id: event.id || `toolu_${randomUUID().slice(0, 16)}`,
            name: event.name,
            input: event.input ?? {},
          });
          break;
        case "finish":
          usage = event.usage;
          finishReason = event.finishReason;
          break;
        default:
          break;
      }
    });

    const content = [];
    if (wantsThinking && reasoning) {
      content.push({ type: "thinking", thinking: reasoning, signature: "" });
    }
    if (text || toolUses.length === 0) content.push({ type: "text", text });
    content.push(...toolUses);

    const u = usage ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    json(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: prepared.model,
      content,
      stop_reason:
        finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_tokens,
        cache_creation_input_tokens: u.cache_write_tokens,
      },
    });
  } finally {
    prepared.release();
  }
}

function normalizeEffort(value) {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  if (v === "none" || v === "off") return "off";
  if (v === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(v)) return v;
  return undefined;
}

function clampMaxTokens(requested) {
  const value = Number(requested);
  if (Number.isFinite(value) && value > 0) return Math.min(value, config.maxOutputTokens);
  return config.maxOutputTokens;
}

/** Aborts the upstream request when the client drops the connection. */
function abortSignal(res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  });
  return controller.signal;
}

// --------------------------------------------------------------- attachment

relay.pool = pool;

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`cmdcd-relay listening on http://${shown}:${config.port}`);
  console.log(`  admin page:   http://${shown}:${config.port}/`);
  console.log(`  OpenAI base:  http://${shown}:${config.port}/v1`);
  console.log(`  upstream:     ${config.upstreamBase}`);
  if (!store.listAccounts().length) {
    console.log("  no accounts yet — add one from the admin page");
  }
  if (!store.listApiKeys().length) {
    console.log("  no API keys yet — create one from the admin page");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
