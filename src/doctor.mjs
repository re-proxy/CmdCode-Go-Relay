import { config } from "./config.mjs";
import { Store } from "./store.mjs";
import { getCatalog, whoami, fetchCredits, UpstreamError } from "./upstream.mjs";
import { summarizeCredits } from "./credits.mjs";

/**
 * `node src/server.mjs doctor`
 *
 * Prints a pass/fail line per dependency so a first deployment can be diagnosed
 * without reading logs. Read-only with respect to accounts: it never changes
 * enable flags or credentials.
 */

const OK = "  ok   ";
const BAD = "  FAIL ";
const WARN = "  warn ";

let failures = 0;
let warnings = 0;

function pass(label, detail = "") {
  console.log(`${OK} ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label, detail = "") {
  failures += 1;
  console.log(`${BAD} ${label}${detail ? ` — ${detail}` : ""}`);
}
function warn(label, detail = "") {
  warnings += 1;
  console.log(`${WARN} ${label}${detail ? ` — ${detail}` : ""}`);
}

export async function doctor() {
  console.log("cmdcd-relay doctor\n");

  // --- configuration -------------------------------------------------------
  console.log("configuration");
  if (config.adminPassword) pass("RELAY_ADMIN_PASSWORD is set");
  else fail("RELAY_ADMIN_PASSWORD is not set");

  if (!config.masterKey) {
    fail("RELAY_MASTER_KEY is not set");
  } else {
    const bytes = Buffer.from(config.masterKey, "base64");
    if (bytes.length === 32) pass("RELAY_MASTER_KEY decodes to 32 bytes");
    else fail("RELAY_MASTER_KEY does not decode to 32 bytes", `${bytes.length} bytes`);
  }

  pass("listen address", `${config.host}:${config.port}`);
  pass("upstream", config.upstreamBase);
  pass("impersonated CLI version", config.cliVersion);
  if (config.publicUrl) pass("public URL", config.publicUrl);
  else warn("RELAY_PUBLIC_URL is unset", "login callback is derived from request headers");

  // --- data file -----------------------------------------------------------
  console.log("\nstorage");
  let store = null;
  try {
    store = new Store();
    pass("data file is readable", config.dataFile);
  } catch (error) {
    fail("data file is unreadable", error?.message ?? String(error));
  }

  // --- upstream reachability ----------------------------------------------
  console.log("\nupstream");
  let catalog = null;
  try {
    catalog = await getCatalog();
    pass("model catalog reachable", `${catalog.models.length} models`);
  } catch (error) {
    fail("model catalog unreachable", error?.message ?? String(error));
  }
  if (catalog && catalog.models.length === 0) warn("catalog is empty");

  // --- accounts ------------------------------------------------------------
  console.log("\naccounts");
  const accounts = store ? store.listAccounts() : [];
  if (accounts.length === 0) {
    warn("no accounts yet", "add one from the admin page");
  } else {
    pass(`${accounts.length} account(s) configured`);
    const enabled = accounts.filter((a) => a.enabled);
    if (enabled.length === 0) warn("every account is disabled", "API requests will return 503");

    for (const account of accounts) {
      const credential = store.getAccountCredential(account.id);
      if (!credential) {
        fail(`${account.name}: stored credential cannot be decrypted`, "was RELAY_MASTER_KEY changed?");
        continue;
      }
      if (account.needsReauth) {
        warn(`${account.name}: marked for re-authentication`, "requests skip it until you log in again");
        continue;
      }
      if (!account.enabled) continue;
      try {
        const info = await whoami(credential);
        const who = info?.user?.userName ?? info?.user?.name ?? "unknown user";
        pass(`${account.name}: credential accepted`, who);
        try {
          const data = await fetchCredits(credential, info?.org?.id ?? null);
          const summary = summarizeCredits(data);
          if (summary.available) {
            pass(`${account.name}: credits`, `$${summary.totalCredits.toFixed(2)} (${summary.planId ?? "unknown plan"})`);
          } else {
            warn(`${account.name}: credits unavailable`, summary.errors.join("; ") || "no billing data");
          }
        } catch (error) {
          warn(`${account.name}: credits query failed`, error?.message ?? String(error));
        }
      } catch (error) {
        if (error instanceof UpstreamError && error.code === "upgrade_required") {
          fail(`${account.name}: credential check blocked by a stale CLI version`, error.message);
        } else {
          fail(`${account.name}: credential rejected`, error?.message ?? String(error));
        }
      }
    }
  }

  // --- api keys ------------------------------------------------------------
  console.log("\napi keys");
  const keys = store ? store.listApiKeys() : [];
  if (keys.length === 0) warn("no API keys yet", "create one in the API 接入 tab");
  else {
    const usable = keys.filter((k) => k.enabled);
    if (usable.length === 0) warn("every API key is disabled");
    else pass(`${usable.length} enabled key(s)`, keys.filter((k) => !k.enabled).length ? `${keys.length - usable.length} disabled` : "");
  }

  // --- verdict -------------------------------------------------------------
  console.log("");
  if (failures) {
    console.log(`${failures} check(s) failed${warnings ? `, ${warnings} warning(s)` : ""}.`);
    console.log("Fix the failures above, then run doctor again.");
    return 1;
  }
  if (warnings) {
    console.log(`All checks passed with ${warnings} warning(s).`);
    return 0;
  }
  console.log("All checks passed. The relay is ready to serve requests.");
  return 0;
}
