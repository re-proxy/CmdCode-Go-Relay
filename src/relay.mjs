import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { fetchCredits, getCatalog, openGenerate, resolveModel, whoami, UpstreamError } from "./upstream.mjs";
import { pumpStream } from "./wire.mjs";
import { HttpError } from "./convert.mjs";
import { summarizeCredits, summarizeUsage } from "./credits.mjs";

/**
 * Ties one client request to one pooled account.
 *
 * `prepare()` returns `{ requestId, model, spec, ready, events, release }`.
 * Callers await `ready()` before writing any response bytes, then invoke
 * `events(sink)` exactly once and `release()` afterwards; `release` is the
 * safety net for paths that bail before `events` runs.
 */
export class Relay {
  constructor(store) {
    this.store = store;
    this.pool = null; // set by the server after construction
    this.stats = { requests: 0, errors: 0, startedAt: new Date().toISOString() };
  }

  async #resolveModel(modelId) {
    const catalog = await getCatalog();
    const known = resolveModel(catalog, modelId);
    if (known) return known;
    const available = catalog.models.map((m) => m.id);
    throw new HttpError(
      404,
      `Unknown model "${modelId}". Available models: ${available.slice(0, 12).join(", ")}${
        available.length > 12 ? "…" : ""
      }`,
      { code: "model_not_found" },
    );
  }

  /**
   * Prepares a streaming generation. Resolves the model, lazily acquires an
   * account on first use, and records usage once.
   */
  async prepare({
    model,
    messages,
    tools,
    system,
    maxTokens,
    temperature,
    reasoningEffort,
    signal,
    source = "openai",
    apiKeyId = null,
  }) {
    const spec = await this.#resolveModel(model);

    const effortAllowed =
      !reasoningEffort ||
      (Array.isArray(spec.reasoningEfforts) && spec.reasoningEfforts.includes(reasoningEffort))
        ? reasoningEffort
        : undefined;

    let ticket = null;
    const started = Date.now();
    const requestId = randomUUID();
    let record = null;

    let stream = null;

    const ensureTicket = async () => {
      if (!ticket) ticket = await this.pool.acquire({ signal });
      return ticket;
    };

    /**
     * Opens the upstream request without consuming it. Callers await this
     * before writing their own headers so auth/shape failures surface as a
     * real status code instead of a frame inside an already-committed stream.
     */
    const open = async () => {
      if (stream) return;
      const acquired = await ensureTicket();
      try {
        stream = await openGenerate({
          apiKey: acquired.apiKey,
          model: spec.id,
          messages,
          tools,
          system,
          maxTokens,
          temperature,
          reasoningEffort: effortAllowed,
          signal,
        });
      } catch (error) {
        this.pool.noteResult(acquired.account.id, { ok: false, error });
        this.#recordFailure(acquired, requestId, started, source, model, apiKeyId, error);
        throw error;
      }
    };

    const events = async (sink) => {
      const acquired = await ensureTicket();
      if (!stream) {
        try {
          stream = await openGenerate({
            apiKey: acquired.apiKey,
            model: spec.id,
            messages,
            tools,
            system,
            maxTokens,
            temperature,
            reasoningEffort: effortAllowed,
            signal,
          });
        } catch (error) {
          this.pool.noteResult(acquired.account.id, { ok: false, error });
          this.#recordFailure(acquired, requestId, started, source, model, apiKeyId, error);
          throw error;
        }
      }
      try {
        const result = await pumpStream(stream, sink);
        this.pool.noteResult(acquired.account.id, { ok: true });
        record = {
          ok: true,
          usage: result.usage,
          finishReason: result.finishReason,
        };
        return result;
      } catch (error) {
        this.pool.noteResult(acquired.account.id, { ok: false, error });
        record = { ok: false, error: error?.message ?? String(error), usage: null };
        throw error;
      } finally {
        const latency = Date.now() - started;
        this.stats.requests += 1;
        if (!record?.ok) this.stats.errors += 1;
        this.store.recordUsage({
          id: requestId,
          source,
          model,
          account: acquired.account.name,
          apiKeyId,
          ok: Boolean(record?.ok),
          error: record?.ok ? null : record?.error ?? null,
          latencyMs: latency,
          usage: record?.usage ?? null,
        });
        acquired.release();
        ticket = null;
      }
    };

    return {
      requestId,
      model: spec.id,
      spec,
      events,
      /** Acquires an account and opens the upstream request before headers. */
      ready: async () => {
        await ensureTicket();
        await open();
      },
      release: () => {
        if (ticket) {
          ticket.release();
          ticket = null;
        }
      },
    };
  }

  #recordFailure(acquired, requestId, started, source, model, apiKeyId, error) {
    this.stats.requests += 1;
    this.stats.errors += 1;
    this.store.recordUsage({
      id: requestId,
      source,
      model,
      account: acquired.account.name,
      apiKeyId,
      ok: false,
      error: error?.message ?? String(error),
      latencyMs: Date.now() - started,
      usage: null,
    });
    acquired.release();
  }

  async checkAllAccounts() {
    const results = [];
    for (const account of this.store.listAccounts()) {
      results.push(await this.checkAccount(account.id));
    }
    return results;
  }

  async checkAccount(id) {
    const credential = this.store.getAccountCredential(id);
    if (!credential) {
      return { id, ok: false, error: "credential unavailable" };
    }
    const started = Date.now();
    try {
      const info = await whoami(credential);
      const latency = Date.now() - started;
      const user = info?.user ?? {};
      const org = info?.org ?? {};
      this.store.updateAccount(id, {
        lastCheckedAt: new Date().toISOString(),
        lastCheckOk: true,
        lastCheckError: null,
        needsReauth: false,
        lastCheckLatencyMs: latency,
        userName: user.userName ?? user.name ?? null,
        userId: user.id ?? null,
        planId: org.planId ?? info?.planId ?? null,
      });
      return { id, ok: true, latency, user, org };
    } catch (error) {
      const latency = Date.now() - started;
      const message = error?.message ?? String(error);
      const credentialRejected =
        Number(error?.status) === 401 || /invalid 'authorization'|rejected this api key/i.test(message);
      this.store.updateAccount(id, {
        lastCheckedAt: new Date().toISOString(),
        lastCheckOk: false,
        lastCheckError: message,
        lastCheckLatencyMs: latency,
        ...(credentialRejected ? { needsReauth: true } : {}),
      });
      return { id, ok: false, latency, error: message, needsReauth: credentialRejected };
    }
  }

  /**
   * Pulls the credit windows, the plan and the billing-period spend for one
   * account, and stores the normalized view the console renders.
   */
  async refreshCredits(id) {
    if (!id) throw new HttpError(400, "`id` is required", { code: "missing_account_id" });
    const credential = this.store.getAccountCredential(id);
    if (!credential) throw new HttpError(404, "Account not found", { code: "account_not_found" });
    const account = this.store.getAccount(id);
    const data = await fetchCredits(credential, account?.orgId ?? null);

    if (!account?.orgId && data.orgId) {
      this.store.updateAccount(id, { orgId: data.orgId });
    }

    const summary = summarizeCredits(data);
    const usage = summarizeUsage(data, { studioBase: config.studioBase });
    this.store.updateAccount(id, {
      credits: summary,
      usage,
      usageCheckedAt: new Date().toISOString(),
      creditsCheckedAt: new Date().toISOString(),
      // A working usage read also proves the credential is still accepted.
      needsReauth: false,
    });
    return { summary, usage, raw: data };
  }

  /** Refreshes every enabled account; failures are reported per account. */
  async refreshAllUsage() {
    const results = [];
    for (const account of this.store.listAccounts()) {
      try {
        const { usage } = await this.refreshCredits(account.id);
        results.push({ id: account.id, name: account.name, ok: usage?.available === true });
      } catch (error) {
        results.push({ id: account.id, name: account.name, ok: false, error: error?.message ?? String(error) });
      }
    }
    return results;
  }
}

