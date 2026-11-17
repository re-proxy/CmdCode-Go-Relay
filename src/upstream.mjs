import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";

/**
 * Upstream transport for Command Code's CLI gateway.
 *
 * The coding plans are metered through `POST /alpha/generate`, the same route
 * the official `command-code` CLI uses. The public `/provider/v1/*` routes are a
 * separate, higher tier, so a CodingPlan subscription has to go through
 * `/alpha/generate` to be usable at all.
 */

const REASONING_EFFORTS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set(["standard", "plan", "auto-accept"]);

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = "upstream_error", retryable = false } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function cliHeaders({ apiKey, sessionId, tasteLearning = false }) {
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "cli",
    "x-command-code-version": config.cliVersion,
    "x-cli-environment": config.cliEnvironment,
    "x-project-slug": config.projectSlug,
    "x-taste-learning": String(tasteLearning),
    "x-session-id": sessionId,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function serverConfig() {
  return {
    workingDir: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform,
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

function normalizePermissionMode(mode) {
  return PERMISSION_MODES.has(mode) ? mode : "standard";
}

export function normalizeReasoningEffort(effort) {
  if (typeof effort !== "string") return undefined;
  const value = effort.trim().toLowerCase();
  if (value === "minimal") return "low";
  if (value === "none") return "off";
  return REASONING_EFFORTS.has(value) ? value : undefined;
}

/**
 * Runs one streaming generation.
 * Returns an async iterator of already-parsed upstream events.
 */
/**
 * Opens one streaming generation and returns its event iterator.
 *
 * The HTTP request happens here, not on first `next()`, so callers can learn
 * about authentication and validation failures before committing response
 * headers to their own client.
 */
export async function openGenerate({
  apiKey,
  model,
  messages,
  tools = [],
  system,
  maxTokens,
  temperature,
  reasoningEffort,
  permissionMode = "standard",
  mode = "agent",
  sessionId = randomUUID(),
  signal,
}) {
  const body = {
    config: serverConfig(),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: normalizePermissionMode(permissionMode),
    mode,
    promptCache: "off",
    params: {
      model,
      messages,
      tools,
      system,
      max_tokens: maxTokens ?? config.maxOutputTokens,
      stream: true,
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  };

  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetch(`${config.upstreamBase}/alpha/generate`, {
      method: "POST",
      headers: cliHeaders({ apiKey, sessionId }),
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new UpstreamError("Upstream request timed out", {
        status: 504,
        code: "upstream_timeout",
      });
    }
    if (error?.name === "AbortError") throw error;
    throw new UpstreamError(`Could not reach Command Code: ${error?.message ?? error}`, {
      status: 502,
      code: "upstream_network_error",
      retryable: true,
    });
  }

  if (!response.ok) {
    const text = await safeText(response);
    const parsed = parseUpstreamError(text);
    throw new UpstreamError(
      parsed.code === "upgrade_required"
        ? upgradeHint(parsed)
        : parsed.message,
      {
        status: mapStatus(response.status, parsed.code),
        code: parsed.code,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("event-stream")) {
    // Some failures still answer 200 with an HTML login page.
    const text = await safeText(response);
    throw new UpstreamError(
      `Unexpected upstream content type "${contentType}": ${text.slice(0, 300)}`,
      { status: 502, code: "upstream_bad_response" },
    );
  }

  return parseLines(response, combined);
}

async function* parseLines(response, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        const event = parseEventLine(line);
        if (event) yield event;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const event = parseEventLine(tail);
      if (event) yield event;
    }
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new UpstreamError("Upstream stream stalled", {
        status: 504,
        code: "upstream_timeout",
      });
    }
    throw error;
  }
}

function parseEventLine(line) {
  // Tolerate SSE framing (`data: {...}`) in case the gateway switches.
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function safeText(response) {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function parseUpstreamError(text) {
  try {
    const body = JSON.parse(text);
    const error = body?.error ?? body;
    const code = typeof error?.code === "string" ? error.code : "upstream_error";
    const message =
      (typeof error?.message === "string" && error.message) ||
      (typeof body?.message === "string" && body.message) ||
      text.slice(0, 300) ||
      "Upstream returned an empty error";
    // `upgrade_required` carries the version the gateway now demands.
    const minVersion = typeof error?.minVersion === "string" ? error.minVersion : null;
    return { code, message, minVersion };
  } catch {
    return {
      code: "upstream_error",
      message: text.slice(0, 300) || "Upstream returned an unreadable error",
    };
  }
}

/**
 * Turns the gateway's generic "CLI is out of date" into something the operator
 * can act on: the relay only needs a newer version string in .env.
 */
function upgradeHint({ message, minVersion }) {
  const target = minVersion ?? "a newer release";
  return (
    `${message} — the relay impersonates the CLI, so set ` +
    `RELAY_CLI_VERSION to at least ${target} in .env and restart ` +
    `(docker compose up -d --force-recreate).`
  );
}

function mapStatus(upstreamStatus, code) {
  if (code === "upgrade_required") return 502;
  if (code === "premium_credits_exhausted" || code === "insufficient credits") return 403;
  if (code === "rate_limit_exceeded" || code === "rate_limited") return 429;
  if (upstreamStatus === 401 || upstreamStatus === 403) return upstreamStatus;
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus === 400 || upstreamStatus === 422) return 400;
  if (upstreamStatus >= 500) return 502;
  return upstreamStatus;
}

/** Validates an API key and returns the whoami payload. */
export async function whoami(apiKey) {
  const response = await fetch(`${config.upstreamBase}/alpha/whoami`, {
    headers: cliHeaders({ apiKey, sessionId: randomUUID() }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await safeText(response);
  if (response.status === 401) {
    throw new UpstreamError("Command Code rejected this API key", {
      status: 401,
      code: "invalid_key",
    });
  }
  if (!response.ok) {
    throw new UpstreamError(
      parseUpstreamError(text).message,
      { status: 502, code: "upstream_whoami_failed" },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("Upstream whoami returned invalid JSON", {
      status: 502,
      code: "upstream_bad_response",
    });
  }
}

/** Reads plan/credit information for an account. Best effort. */
export async function fetchCredits(apiKey, orgId) {
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const headers = cliHeaders({ apiKey, sessionId: randomUUID() });
  const out = { credits: null, subscription: null, errors: [] };
  const [credits, subscription] = await Promise.all([
    getJson(`/alpha/billing/credits${query}`, headers),
    getJson(`/alpha/billing/subscriptions${query}`, headers),
  ]);
  if (credits.error) out.errors.push(credits.error);
  else out.credits = credits.data;
  if (subscription.error) out.errors.push(subscription.error);
  else out.subscription = subscription.data;
  return out;
}

async function getJson(path, headers) {
  try {
    const response = await fetch(`${config.upstreamBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    const text = await safeText(response);
    if (!response.ok) {
      return { error: `${path}: ${parseUpstreamError(text).message}`, data: null };
    }
    return { data: JSON.parse(text), error: null };
  } catch (error) {
    return { error: `${path}: ${error?.message ?? error}`, data: null };
  }
}

/**
 * Model catalog, merged from the two listings the CLI itself uses.
 *
 * `/provider/v1/models` is the public API view and `/provider/v1/models?view=client`
 * is the CLI view. The client view is a superset in practice (free tiers and
 * stealth previews only appear there) and every id in it is reachable through
 * `/alpha/generate`, so the relay must offer the union — otherwise a paid
 * subscriber would see models the CLI can use but the relay rejects as 404.
 */
let catalogCache = { at: 0, models: null, byId: null };

const CATALOG_FETCH_HEADERS = {
  accept: "application/json",
  "user-agent": "cli",
  "x-command-code-version": config.cliVersion,
};

async function fetchCatalogView(suffix) {
  const response = await fetch(`${config.upstreamBase}/provider/v1/models${suffix}`, {
    headers: CATALOG_FETCH_HEADERS,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getCatalog() {
  if (catalogCache.models && Date.now() - catalogCache.at < config.catalogTtlMs) {
    return catalogCache;
  }

  const [providerView, clientView] = await Promise.all([
    fetchCatalogView(""),
    fetchCatalogView("?view=client"),
  ]);

  if (!providerView && !clientView) {
    if (catalogCache.models) return catalogCache;
    throw new UpstreamError("Could not load the model catalog", {
      status: 502,
      code: "catalog_unavailable",
    });
  }

  const merged = new Map();
  for (const model of providerView?.data ?? []) {
    merged.set(model.id, {
      id: model.id,
      object: "model",
      created: model.created ?? null,
      owned_by: model.owned_by ?? "command-code",
      name: model.name ?? model.id,
      context_length: model.context_length ?? null,
      maxOutputTokens: null,
      supported_endpoints: model.supported_endpoints ?? [],
      category: null,
      minimumPlan: null,
      reasoningEfforts: [],
      inputModalities: ["text"],
      pricing: null,
      display: null,
      hidden: false,
      aliases: [],
    });
  }

  for (const model of clientView?.data ?? []) {
    const base = merged.get(model.id) ?? {
      id: model.id,
      object: "model",
      created: null,
      owned_by: model.owned_by ?? "command-code",
      supported_endpoints: [],
    };
    merged.set(model.id, {
      ...base,
      name: model.name ?? base.name ?? model.id,
      context_length: base.context_length ?? model.context_length ?? null,
      maxOutputTokens: model.maxOutputTokens ?? base.maxOutputTokens ?? null,
      category: model.category ?? null,
      minimumPlan: model.minimumPlan ?? null,
      reasoningEfforts: model.reasoningEfforts ?? [],
      inputModalities: model.inputModalities ?? ["text"],
      pricing: model.pricing ?? null,
      display: model.display ?? null,
      hidden: model.hidden === true,
      aliases: model.aliases ?? [],
    });
  }

  const models = [...merged.values()];
  const byId = new Map(models.map((model) => [model.id, model]));
  catalogCache = { at: Date.now(), models, byId };
  return catalogCache;
}

/** Catalog lookup that tolerates aliases declared by the client listing. */
export function resolveModel(catalog, requestedId) {
  const direct = catalog.byId.get(requestedId);
  if (direct) return direct;
  for (const model of catalog.models) {
    if (model.aliases?.includes(requestedId)) return model;
  }
  return null;
}

/** Listing used by `/v1/models` and the admin console. */
export async function listModels() {
  const catalog = await getCatalog();
  return catalog.models;
}
