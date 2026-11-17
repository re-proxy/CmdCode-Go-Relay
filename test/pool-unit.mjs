import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unit tests for the account pool's failure policy.
 *
 * These run against a real Store in a temp directory so the persistence path is
 * covered too, but they never talk to the network.
 */

process.env.RELAY_ADMIN_PASSWORD ??= "unit";
process.env.RELAY_MASTER_KEY ??= randomBytes(32).toString("base64");

const { Store } = await import("../src/store.mjs");
const { AccountPool } = await import("../src/pool.mjs");

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "pool-unit-"));
try {
  const store = new Store(join(dir, "relay.json"));
  const pool = new AccountPool(store);

  const account = store.addAccount({ name: "primary", apiKey: "sk-credential", userName: "u" });

  check("a fresh account starts unauthenticated but usable", account.needsReauth === false);

  // Transient failure: keep it usable, just record the error.
  pool.noteResult(account.id, { ok: false, error: Object.assign(new Error("rate limited"), { status: 429 }) });
  let view = store.listAccounts().find((a) => a.id === account.id);
  check("a 429 does not park the account", view.needsReauth === false, JSON.stringify(view.lastCheckError));
  check("a 429 is recorded as the last error", /rate limited/.test(view.lastCheckError), view.lastCheckError);

  // Auth failure: park it.
  pool.noteResult(account.id, {
    ok: false,
    error: Object.assign(new Error("Invalid 'Authorization' header or token."), { status: 401 }),
  });
  view = store.listAccounts().find((a) => a.id === account.id);
  check("a 401 parks the account", view.needsReauth === true);
  check("a parked account stays enabled so it is still visible", view.enabled === true);
  check("a parked account keeps its credential", store.getAccountCredential(account.id) === "sk-credential");

  // The pool must refuse to hand out a parked account, with a clear reason.
  let acquired = null;
  let error = null;
  try {
    acquired = await pool.acquire({});
  } catch (caught) {
    error = caught;
  }
  acquired?.release();
  check("a parked account is skipped by the pool", acquired === null, "pool handed out a parked account");
  check("the pool names re-authentication as the cause", error?.code === "account_needs_reauth", error?.code);
  check("the pool message tells the user what to do", /re-authenticate/i.test(error?.message ?? ""), error?.message);

  // A later success revives it.
  pool.noteResult(account.id, { ok: true });
  view = store.listAccounts().find((a) => a.id === account.id);
  check("a successful request clears the parking flag", view.needsReauth === false);

  const revived = await pool.acquire({});
  check("a revived account is handed out again", revived?.account?.id === account.id);
  revived?.release();

  // No accounts at all is a different, distinct error.
  const emptyStore = new Store(join(dir, "empty.json"));
  const emptyPool = new AccountPool(emptyStore);
  let emptyError = null;
  try {
    await emptyPool.acquire({});
  } catch (caught) {
    emptyError = caught;
  }
  check("an empty pool reports no_enabled_account", emptyError?.code === "no_enabled_account", emptyError?.code);

  // Disabled accounts are ignored regardless of parking state.
  store.updateAccount(account.id, { enabled: false });
  let disabledError = null;
  try {
    await emptyPool.acquire({});
  } catch (caught) {
    disabledError = caught;
  }
  check("a store with only disabled accounts reports no account", disabledError?.code === "no_enabled_account", disabledError?.code);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} pool check(s) failed` : "\npool unit checks ok");
if (failures) process.exitCode = 1;
