import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader: KEY=value, # comments, optional quotes. */
function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadDotEnv(resolve(ROOT, ".env"));

function env(name, fallback = undefined) {
  const v = process.env[name] ?? fileEnv[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_UPSTREAM = "https://api.commandcode.ai";
const DEFAULT_CLI_VERSION = "1.89.2";

export const config = {
  port: num("RELAY_PORT", 8317),
  host: env("RELAY_HOST", "0.0.0.0"),
  /** Public base URL used to build the login callback; falls back to the request origin. */
  publicUrl: env("RELAY_PUBLIC_URL", ""),
  adminPassword: env("RELAY_ADMIN_PASSWORD", ""),
  masterKey: env("RELAY_MASTER_KEY", ""),
  dataFile: env("RELAY_DATA_FILE", resolve(ROOT, "data", "relay.json")),
  upstreamBase: env("RELAY_UPSTREAM_BASE", DEFAULT_UPSTREAM).replace(/\/+$/, ""),
  studioBase: env("RELAY_STUDIO_BASE", "https://commandcode.ai").replace(/\/+$/, ""),
  cliVersion: env("RELAY_CLI_VERSION", DEFAULT_CLI_VERSION),
  cliEnvironment: env("RELAY_CLI_ENVIRONMENT", "production"),
  projectSlug: env("RELAY_PROJECT_SLUG", "relay"),
  maxConcurrent: num("RELAY_MAX_CONCURRENT", 4),
  accountQueueMs: num("RELAY_ACCOUNT_QUEUE_MS", 60000),
  maxOutputTokens: num("RELAY_MAX_OUTPUT_TOKENS", 32000),
  upstreamTimeoutMs: num("RELAY_UPSTREAM_TIMEOUT_MS", 120000),
  catalogTtlMs: num("RELAY_CATALOG_TTL_MS", 15 * 60 * 1000),
  sessionTtlMs: num("RELAY_SESSION_TTL_MS", 12 * 60 * 60 * 1000),
  usageLimit: num("RELAY_USAGE_LIMIT", 500),
};

export function validateConfig() {
  const problems = [];
  if (!config.adminPassword) problems.push("RELAY_ADMIN_PASSWORD is required");
  if (!config.masterKey) {
    problems.push("RELAY_MASTER_KEY is required (32 random bytes, standard Base64)");
  } else {
    let bytes = null;
    try {
      bytes = Buffer.from(config.masterKey, "base64");
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.length !== 32) {
      problems.push("RELAY_MASTER_KEY must decode to exactly 32 bytes (standard Base64)");
    }
  }
  return problems;
}
