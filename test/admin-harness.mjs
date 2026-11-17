import vm from "node:vm";
import { renderAdminPage } from "../src/admin-ui.mjs";

/**
 * Minimal DOM harness that runs the admin page's browser script and asserts the
 * first paint plus a tab switch complete without throwing. It is not a browser:
 * it verifies control flow (no undefined access, no missing handlers) rather
 * than layout.
 */

function makeElement(tag = "div") {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    value: "",
    textContent: "",
    _html: "",
    disabled: false,
    onclick: null,
    oninput: null,
    onchange: null,
    className: "",
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
      // Parse ids/attributes so later lookups can succeed.
      for (const match of this._html.matchAll(/id="([^"]+)"/g)) {
        registry.set(match[1], makeElement("div"));
      }
      for (const match of this._html.matchAll(/data-(act|kact|tab)="([^"]+)"/g)) {
        registry.set(`@${match[1]}:${match[2]}`, makeElement("button"));
      }
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    setAttribute() {},
    querySelector(sel) {
      return lookup(sel);
    },
    querySelectorAll(sel) {
      return lookupAll(sel);
    },
  };
  return el;
}

const registry = new Map();
const bySelector = new Map();

function lookup(sel) {
  if (bySelector.has(sel)) return bySelector.get(sel);
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    if (!registry.has(id)) registry.set(id, makeElement("div"));
    return registry.get(id);
  }
  return makeElement("div");
}

function lookupAll() {
  return [];
}

const document = {
  body: makeElement("body"),
  createElement: makeElement,
  querySelector(sel) {
    return lookup(sel);
  },
  querySelectorAll() {
    return [];
  },
};

const requests = [];
const fetchStub = async (path, options = {}) => {
  requests.push({ path, options });
  const ok = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

  if (path === "/admin/api/overview") {
    return ok({
      relay: { requests: 3, errors: 1, startedAt: "2026-01-01T00:00:00Z", maxConcurrent: 4, upstream: "https://api.commandcode.ai", cliVersion: "1.89.2" },
      accounts: [
        {
          id: "acc1", name: "main", enabled: true, userName: "tester", userId: "u", keyName: "k",
          lastCheckedAt: "2026-01-01T00:00:00Z", lastCheckOk: false, needsReauth: true, lastCheckError: "Command Code rejected this API key",
          lastCheckLatencyMs: 42, planId: "individual-go", createdAt: "2026-01-01T00:00:00Z",
          lastUsedAt: "2026-01-01T00:00:00Z",
          credits: { available: true, totalCredits: 5.5, monthlyCredits: 4.5 },
        },
      ],
      apiKeys: [{ id: "k1", name: "client", prefix: "sk-cmd-abc", suffix: "xyz123", enabled: true, createdAt: "2026-01-01T00:00:00Z", requestCount: 2, lastUsedAt: null }],
      usage: [{ id: "r1", at: "2026-01-01T00:00:00Z", model: "deepseek/deepseek-v4.1-flash", source: "openai", ok: true, latencyMs: 120, account: "main", usage: { inputTokens: 10, outputTokens: 5 } }],
      pool: [],
    });
  }
  if (path === "/admin/api/models") {
    return ok({
      prefs: {},
      models: [
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1000000, reasoningEfforts: ["low"], pricing: { inputCost: 0.15, outputCost: 0.6 }, minimumPlan: "individual-go", category: "opensource", supported_endpoints: ["/chat/completions"] },
      ],
    });
  }
  return ok({ ok: true, key: "sk-cmd-new", results: [], account: {}, summary: { available: true } });
};

const html = renderAdminPage({ authenticated: true, baseUrl: "http://127.0.0.1:8317" });
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const bootJson = html.match(/window\.__BOOT__ = (\{[\s\S]*?\});/)[1];

const sandbox = {
  window: { __BOOT__: JSON.parse(bootJson) },
  document,
  fetch: fetchStub,
  console,
  setTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  confirm: () => true,
  JSON,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  Boolean,
  Error,
  Promise,
  encodeURIComponent,
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
const switchHook = `
globalThis.__switchTab = (tab) => { state.tab = tab; render(); };
`;
const code = switchHook + script;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  new vm.Script(code, { filename: "admin-ui.js" }).runInContext(context);
  await new Promise((r) => setTimeout(r, 50));
  check("admin script runs without throwing", true);
  check("admin script requests the overview", requests.some((r) => r.path === "/admin/api/overview"));
  check("admin script only talks to the admin API", requests.every((r) => r.path.startsWith("/admin/api/")));

  // Tab switching exercises every render path with real payloads.
  for (const tab of ["models", "keys", "usage", "accounts"]) {
    try {
      context.__switchTab(tab);
      await new Promise((r) => setTimeout(r, 20));
      check(`tab "${tab}" renders without throwing`, true);
    } catch (error) {
      check(`tab "${tab}" renders without throwing`, false, error?.message);
    }
  }
} catch (error) {
  check("admin script runs without throwing", false, error?.stack?.split("\n").slice(0, 3).join(" | "));
}

console.log(failures ? `\n${failures} admin harness check(s) failed` : "\nadmin harness ok");
if (failures) process.exitCode = 1;
