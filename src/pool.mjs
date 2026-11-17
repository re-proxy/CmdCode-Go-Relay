import { config } from "./config.mjs";
import { UpstreamError } from "./upstream.mjs";

/**
 * Round-robin account pool with a per-account concurrency gate.
 * An account whose credential stops working is disabled so later requests
 * move on instead of failing the same way.
 */
export class AccountPool {
  constructor(store) {
    this.store = store;
    this.cursor = 0;
    this.active = new Map(); // accountId -> in-flight count
  }

  #inFlight(id) {
    return this.active.get(id) ?? 0;
  }

  #acquire(id) {
    this.active.set(id, this.#inFlight(id) + 1);
  }

  #release(id) {
    const next = this.#inFlight(id) - 1;
    if (next <= 0) this.active.delete(id);
    else this.active.set(id, next);
  }

  /** Picks the next account with spare capacity, waiting briefly if needed. */
  async acquire({ signal } = {}) {
    const deadline = Date.now() + config.accountQueueMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const enabled = this.store.enabledAccounts();
      const accounts = enabled.filter((a) => !a.needsReauth);
      if (accounts.length === 0) {
        const parked = enabled.length > 0;
        throw new UpstreamError(
          parked
            ? "Every enabled account was rejected by Command Code. Re-authenticate one in the relay admin page."
            : "No enabled Command Code account. Add one in the relay admin page.",
          { status: 503, code: parked ? "account_needs_reauth" : "no_enabled_account" },
        );
      }
      const ordered = this.#rotate(accounts);
      const free = ordered.find((a) => this.#inFlight(a.id) < config.maxConcurrent);
      if (free) {
        this.#acquire(free.id);
        const credential = this.store.getAccountCredential(free.id);
        if (!credential) {
          this.#release(free.id);
          this.store.updateAccount(free.id, {
            enabled: false,
            lastCheckOk: false,
            lastCheckError: "Stored credential could not be decrypted",
          });
          continue;
        }
        return {
          account: free,
          apiKey: credential,
          release: () => this.#release(free.id),
        };
      }
      if (Date.now() >= deadline) {
        throw new UpstreamError(
          "Every enabled account is at its concurrency limit",
          { status: 503, code: "account_concurrency_limit" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  #rotate(accounts) {
    if (accounts.length === 1) return accounts;
    const start = this.cursor % accounts.length;
    this.cursor = (this.cursor + 1) % accounts.length;
    return [...accounts.slice(start), ...accounts.slice(0, start)];
  }

  /**
   * Records the outcome of a request against an account.
   *
   * A rejected credential is parked rather than disabled: disabling the last
   * account turns every later request into a 503 that says "no account", which
   * hides the real cause. A parked account keeps its key, is skipped by the
   * pool, and is revived as soon as a check or a request succeeds.
   */
  noteResult(accountId, { ok, error }) {
    const account = this.store.getAccount(accountId);
    if (!account) return;

    const patch = { lastUsedAt: new Date().toISOString() };

    if (ok) {
      patch.lastCheckOk = true;
      patch.lastCheckError = null;
      patch.lastCheckedAt = new Date().toISOString();
      patch.needsReauth = false;
    } else if (error) {
      const message = error.message ?? String(error);
      const status = Number(error.status) || 0;
      const credentialRejected =
        status === 401 || /invalid 'authorization'|invalid api key|rejected this api key/i.test(message);
      patch.lastCheckError = message;
      if (credentialRejected) {
        patch.lastCheckOk = false;
        patch.lastCheckedAt = new Date().toISOString();
        patch.needsReauth = true;
      }
    }

    this.store.updateAccount(accountId, patch);
  }

  async stats() {
    return this.store.enabledAccounts().map((a) => ({
      id: a.id,
      name: a.name,
      inFlight: this.#inFlight(a.id),
      limit: config.maxConcurrent,
    }));
  }
}
