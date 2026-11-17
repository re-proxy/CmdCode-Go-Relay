import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { decryptString, encryptString, deriveKey, randomToken, sha256Hex } from "./crypto.mjs";

const SCHEMA = 1;

function emptyState() {
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    accounts: [],
    apiKeys: [],
    modelPrefs: {},
    usage: [],
  };
}

export class Store {
  constructor(path = config.dataFile) {
    this.path = path;
    this.key = deriveKey(config.masterKey);
    this.state = this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.path)) return emptyState();
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (!raw || typeof raw !== "object") return emptyState();
      return { ...emptyState(), ...raw, schema: SCHEMA };
    } catch {
      return emptyState();
    }
  }

  save() {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // ---------------------------------------------------------------- accounts

  listAccounts() {
    return this.state.accounts.map((a) => this.#publicAccount(a));
  }

  #publicAccount(a) {
    return {
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      userName: a.userName,
      userId: a.userId,
      keyName: a.keyName,
      lastCheckedAt: a.lastCheckedAt ?? null,
      lastCheckOk: a.lastCheckOk ?? null,
      lastCheckError: a.lastCheckError ?? null,
      lastCheckLatencyMs: a.lastCheckLatencyMs ?? null,
      modelCount: a.modelIds?.length ?? null,
      planId: a.planId ?? null,
      createdAt: a.createdAt,
      lastUsedAt: a.lastUsedAt ?? null,
      credits: a.credits ?? null,
      creditsCheckedAt: a.creditsCheckedAt ?? null,
      needsReauth: a.needsReauth === true,
    };
  }

  getAccount(id) {
    return this.state.accounts.find((a) => a.id === id) ?? null;
  }

  /** Returns the decrypted credential for an account, or null. */
  getAccountCredential(id) {
    const account = this.getAccount(id);
    if (!account) return null;
    return decryptString(this.key, account.apiKeyCipher);
  }

  addAccount({ name, apiKey, userName, userId, keyName }) {
    const account = {
      id: randomToken(9).replace(/[-_]/g, "").slice(0, 16),
      name: name || userName || "account",
      enabled: true,
      apiKeyCipher: encryptString(this.key, apiKey),
      apiKeyHint: apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…",
      userName: userName ?? null,
      userId: userId ?? null,
      keyName: keyName ?? null,
      createdAt: new Date().toISOString(),
    };
    this.state.accounts.push(account);
    this.save();
    return this.#publicAccount(account);
  }

  updateAccount(id, patch) {
    const account = this.getAccount(id);
    if (!account) return null;
    Object.assign(account, patch);
    this.save();
    return this.#publicAccount(account);
  }

  setAccountCredential(id, apiKey) {
    const account = this.getAccount(id);
    if (!account) return null;
    account.apiKeyCipher = encryptString(this.key, apiKey);
    account.apiKeyHint = apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…";
    this.save();
    return this.#publicAccount(account);
  }

  removeAccount(id) {
    const before = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    if (this.state.accounts.length === before) return false;
    this.save();
    return true;
  }

  enabledAccounts() {
    return this.state.accounts.filter((a) => a.enabled);
  }

  // ---------------------------------------------------------------- api keys

  listApiKeys() {
    return this.state.apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      suffix: k.suffix,
      enabled: k.enabled,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
      requestCount: k.requestCount ?? 0,
    }));
  }

  createApiKey(name) {
    const secret = `sk-cmd-${randomToken(24)}`;
    const record = {
      id: randomToken(9).replace(/[-_]/g, "").slice(0, 16),
      name: name || "key",
      hash: sha256Hex(secret),
      prefix: secret.slice(0, 10),
      suffix: secret.slice(-6),
      enabled: true,
      createdAt: new Date().toISOString(),
      requestCount: 0,
    };
    this.state.apiKeys.push(record);
    this.save();
    return { id: record.id, name: record.name, key: secret };
  }

  /** Resolves an incoming bearer token to an enabled api key record. */
  findApiKeyBySecret(secret) {
    if (!secret) return null;
    const hash = sha256Hex(secret);
    const record = this.state.apiKeys.find((k) => k.hash === hash);
    if (!record || !record.enabled) return null;
    return record;
  }

  touchApiKey(id) {
    const record = this.state.apiKeys.find((k) => k.id === id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    record.requestCount = (record.requestCount ?? 0) + 1;
    this.save();
  }

  setApiKeyEnabled(id, enabled) {
    const record = this.state.apiKeys.find((k) => k.id === id);
    if (!record) return null;
    record.enabled = Boolean(enabled);
    this.save();
    return { id: record.id, enabled: record.enabled };
  }

  removeApiKey(id) {
    const before = this.state.apiKeys.length;
    this.state.apiKeys = this.state.apiKeys.filter((k) => k.id !== id);
    if (this.state.apiKeys.length === before) return false;
    this.save();
    return true;
  }

  // ------------------------------------------------------------- model prefs

  getModelPrefs() {
    return this.state.modelPrefs ?? {};
  }

  setModelPrefs(prefs) {
    this.state.modelPrefs = prefs ?? {};
    this.save();
  }

  // ------------------------------------------------------------------ usage

  recordUsage(entry) {
    this.state.usage.unshift({ ...entry, at: new Date().toISOString() });
    if (this.state.usage.length > config.usageLimit) {
      this.state.usage.length = config.usageLimit;
    }
    this.save();
  }

  listUsage(limit = 100) {
    return this.state.usage.slice(0, Math.max(1, Math.min(limit, config.usageLimit)));
  }
}
