export function renderAdminPage({ authenticated, baseUrl }) {
  const boot = {
    authenticated,
    baseUrl,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Command Code Relay</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#14171c;--panel2:#191d24;--line:#232a35;--text:#e7e9ee;--muted:#9aa3b2;--accent:#7aa2ff;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
header{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,13,16,.92);backdrop-filter:blur(8px);z-index:10}
header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em}
header .spacer{flex:1}
header .meta{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
main{max-width:1180px;margin:0 auto;padding:24px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:18px;overflow:hidden}
section>h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0;padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
section>h2 .spacer{flex:1}
.pad{padding:18px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 18px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:7px 12px;cursor:pointer;transition:.15s}
button:hover{border-color:#35404f;background:#1e242d}
button.primary{background:#2b4a8f;border-color:#3a5fb0}
button.primary:hover{background:#33559f}
button.ghost{background:transparent}
button.danger{color:var(--err);border-color:#3a2626}
button.danger:hover{background:#241a1a}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;background:#0f1217;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:#3a5fb0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;letter-spacing:.02em;white-space:nowrap}
.b-ok{background:rgba(34,197,94,.14);color:var(--ok)}
.b-err{background:rgba(239,68,68,.14);color:var(--err)}
.b-warn{background:rgba(251,191,36,.14);color:var(--warn)}
.b-muted{background:rgba(148,163,184,.12);color:var(--muted)}
.muted{color:var(--muted)}
.small{font-size:12px}
.hidden{display:none!important}
.card{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}
.card h3{margin:0 0 6px;font-size:13px;font-weight:600}
.card p{margin:0;color:var(--muted);font-size:12px}
.stack{display:flex;flex-direction:column;gap:10px}
pre{background:#0f1217;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px;margin:0}
.toast{position:fixed;right:20px;bottom:20px;background:#1c2129;border:1px solid var(--line);padding:12px 16px;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.5);max-width:420px;z-index:50}
.toast.err{border-color:#3a2626;color:var(--err)}
.toast.ok{border-color:#1f3d2a;color:var(--ok)}
.login{max-width:380px;margin:12vh auto;padding:28px}
.login h1{font-size:18px;margin:0 0 4px}
.login p{color:var(--muted);margin:0 0 18px;font-size:13px}
code{background:#0f1217;padding:2px 6px;border-radius:5px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.bar{height:6px;background:#0f1217;border-radius:999px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#3a5fb0,#7aa2ff)}
</style>
</head>
<body>
<div id="app"></div>
<script>window.__BOOT__ = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>
<script type="module">
const state = {
  boot: window.__BOOT__,
  overview: null,
  models: [],
  prefs: {},
  modelFilter: { q: "", category: "", plan: "" },
  tab: "accounts",
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("en-US"));
const money = (n) => (n === null || n === undefined ? "—" : "$" + Number(n).toFixed(2));
const time = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && path !== "/admin/login") {
      state.boot.authenticated = false;
      render();
    }
    throw new Error(data?.error || data?.message || res.status + " " + res.statusText);
  }
  return data;
}

function render() {
  const app = $("#app");
  if (!state.boot.authenticated) { app.innerHTML = renderLogin(); bindLogin(); return; }
  app.innerHTML = renderShell();
  bindShell();
  if (state.tab === "accounts") renderAccounts();
  if (state.tab === "quota") { state.quota = null; renderQuota(); }
  if (state.tab === "models") renderModels();
  if (state.tab === "keys") renderKeys();
  if (state.tab === "usage") renderUsage();
}

function renderLogin() {
  return '<div class="login"><section><div class="pad">'
    + '<h1>Command Code Relay</h1>'
    + '<p>输入管理密码进入控制台。</p>'
    + '<div class="stack"><input id="password" type="password" placeholder="管理密码" autofocus>'
    + '<button class="primary" id="loginBtn">登录</button></div>'
    + '</div></section></div>';
}

function bindLogin() {
  const submit = async () => {
    const password = $("#password").value;
    try {
      await api("/admin/login", { method: "POST", body: { password } });
      state.boot.authenticated = true;
      render();
      loadOverview();
    } catch (err) { toast(err.message, "err"); }
  };
  $("#loginBtn").onclick = submit;
  $("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

function renderShell() {
  const tabs = [["accounts", "账号"], ["quota", "用量"], ["models", "模型"], ["keys", "API 接入"], ["usage", "请求记录"]];
  return '<header><h1>Command Code Relay</h1>'
    + '<span class="spacer"></span>'
    + tabs.map(([id, label]) => '<button class="ghost' + (state.tab === id ? " primary" : "") + '" data-tab="' + id + '">' + label + '</button>').join("")
    + '<span class="meta" id="hdrMeta"></span>'
    + '<button class="ghost" id="logout">退出</button></header>'
    + '<main>'
    + '<section id="secAccounts" class="' + (state.tab === "accounts" ? "" : "hidden") + '"></section>'
    + '<section id="secQuota" class="' + (state.tab === "quota" ? "" : "hidden") + '"></section>'
    + '<section id="secModels" class="' + (state.tab === "models" ? "" : "hidden") + '"></section>'
    + '<section id="secKeys" class="' + (state.tab === "keys" ? "" : "hidden") + '"></section>'
    + '<section id="secUsage" class="' + (state.tab === "usage" ? "" : "hidden") + '"></section>'
    + '</main>';
}

function bindShell() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => { state.tab = btn.dataset.tab; render(); };
  });
  $("#logout").onclick = async () => {
    try { await api("/admin/logout", { method: "POST" }); } catch {}
    state.boot.authenticated = false;
    render();
  };
}

async function loadOverview() {
  try {
    state.overview = await api("/admin/api/overview");
    const meta = $("#hdrMeta");
    if (meta) {
      const o = state.overview.relay;
      meta.textContent = o.requests + " 请求 · " + o.errors + " 失败 · " + (state.overview.accounts.length) + " 账号";
    }
    if (state.tab === "accounts") paintAccounts();
    if (state.tab === "keys") renderKeys();
    if (state.tab === "usage") renderUsage();
  } catch (err) { toast(err.message, "err"); }
}

function accountRows() {
  const o = state.overview;
  if (!o) return '<tr><td colspan="7" class="pad muted">加载中…</td></tr>';
  const rows = o.accounts.map((a) => {
    const status = a.needsReauth
      ? '<span class="badge b-warn">需重新登录</span>'
      : a.lastCheckOk === null || a.lastCheckOk === undefined
        ? '<span class="badge b-muted">未验证</span>'
        : a.lastCheckOk
          ? '<span class="badge b-ok">正常</span>'
          : '<span class="badge b-err">失败</span>';
    const credits = a.credits?.available
      ? money(a.credits.totalCredits) + ' <span class="muted small">(' + money(a.credits.monthlyCredits) + ' 月度)</span>'
      : '<span class="muted">未知</span>';
    return '<tr>'
      + '<td><div>' + esc(a.name) + '</div><div class="muted small mono">' + esc(a.id) + '</div></td>'
      + '<td>' + (a.needsReauth
        ? '<span class="badge b-warn">已暂停</span>'
        : a.enabled ? '<span class="badge b-ok">已启用</span>' : '<span class="badge b-muted">已停用</span>') + '</td>'
      + '<td>' + status + (a.lastCheckLatencyMs ? ' <span class="muted small">' + a.lastCheckLatencyMs + 'ms</span>' : '')
      + (a.lastCheckOk === false && a.lastCheckError ? '<div class="small muted">' + esc(a.lastCheckError).slice(0, 120) + '</div>' : '')
      + '</td>'
      + '<td>' + credits + '</td>'
      + '<td class="small muted">' + esc(a.planId || "—") + '<br>' + esc(a.userName || "") + '</td>'
      + '<td class="small muted">' + time(a.lastUsedAt) + '</td>'
      + '<td><div class="row">'
      + '<button data-act="check" data-id="' + a.id + '">验证</button>'
      + '<button data-act="credits" data-id="' + a.id + '">余额</button>'
      + (a.needsReauth
        ? '<button data-act="retry" data-id="' + a.id + '">重新启用</button>'
        : '<button data-act="toggle" data-id="' + a.id + '" data-enabled="' + (!a.enabled) + '">' + (a.enabled ? "停用" : "启用") + '</button>')
      + '<button class="danger" data-act="delete" data-id="' + a.id + '">删除</button>'
      + '</div></td></tr>';
  }).join("");
  return rows || '<tr><td colspan="7" class="pad muted">还没有账号</td></tr>';
}

/**
 * Re-renders only the account table. The onboarding cards and any in-progress
 * input survive the 15 s refresh, which is why they are not part of this path.
 */
function paintAccounts() {
  const body = $("#accRows");
  if (!body) { renderAccounts(); return; }
  body.innerHTML = accountRows();
  bindAccountRowActions();
}

function bindAccountRowActions() {
  document.querySelectorAll('#secAccounts [data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        if (btn.dataset.act === "check") {
          await api("/admin/api/accounts/check", { method: "POST", body: { id } });
        }
        if (btn.dataset.act === "credits") {
          const r = await api("/admin/api/accounts/credits", { method: "POST", body: { id } });
          toast(r.summary?.available ? "余额已更新" : "上游未返回余额");
        }
        if (btn.dataset.act === "toggle") {
          await api("/admin/api/accounts/" + id, { method: "PATCH", body: { enabled: btn.dataset.enabled === "true" } });
        }
        if (btn.dataset.act === "retry") {
          await api("/admin/api/accounts/" + id, { method: "PATCH", body: { clearReauth: true, enabled: true } });
        }
        if (btn.dataset.act === "delete") {
          if (!confirm("删除这个账号？")) { btn.disabled = false; return; }
          await api("/admin/api/accounts/" + id, { method: "DELETE" });
        }
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };
  });
}

function renderAccounts() {
  const sec = $("#secAccounts");
  // Build the section shell once; later refreshes only repaint the table.
  if (!$("#accRows")) {
    sec.innerHTML = ''
      + '<h2>账号<span class="spacer"></span><button id="checkAll">全部验证</button></h2>'
      + '<div class="pad"><div class="grid">'
      + '<div class="card"><h3>浏览器登录</h3><p>打开官方登录页授权。回调只用 localhost，在本机或 SSH 隧道下可全自动完成。</p>'
      + '<div class="row" style="margin-top:10px"><button class="primary" id="startLogin">生成登录链接</button></div>'
      + '<div id="loginBox" class="stack" style="margin-top:10px"></div></div>'
      + '<div class="card"><h3>粘贴回调 / API Key</h3><p>把授权页给出的 API Key、完整回调 URL，或 <code>~/.commandcode/auth.json</code> 里的 key 贴进来。</p>'
      + '<div class="stack" style="margin-top:10px"><input id="pasteName" placeholder="账号名称（可选）">'
      + '<textarea id="pasteValue" rows="3" placeholder="http://127.0.0.1:xxxx/callback?apiKey=... 或 sk-..."></textarea>'
      + '<button class="primary" id="pasteSubmit">添加账号</button></div></div>'
      + '<div class="card"><h3>从本机导入</h3><p>读取本机 <code>~/.commandcode/auth.json</code>。</p>'
      + '<div class="row" style="margin-top:10px"><button id="importLocal">导入本机登录态</button></div></div>'
      + '</div></div>'
      + '<table><thead><tr><th>账号</th><th>状态</th><th>连通性</th><th>余额</th><th>套餐 / 用户</th><th>最近使用</th><th></th></tr></thead>'
      + '<tbody id="accRows"></tbody></table>';

    $("#checkAll").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api("/admin/api/accounts/check", { method: "POST", body: {} });
        toast("已检查 " + r.results.length + " 个账号");
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };

    $("#startLogin").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api("/admin/api/accounts/login-url", { method: "POST", body: {} });
        const warning = r.warning
          ? '<p class="small" style="color:var(--warn)">' + esc(r.warning) + '</p>'
          : "";
        const explanation = r.mode === "automatic"
          ? '<p class="small muted">授权后官方页面会跳回本服务的 <code>' + esc(r.callback) + '</code>，账号自动写入，无需复制任何东西。</p>'
          : '<p class="small muted">这台机器上浏览器访问不到回调地址（Command Code 只允许 localhost 回调）。授权后页面多半会提示无法连接，'
            + '并显示一串 API Key —— 复制它，用右侧「粘贴回调 / API Key」提交即可。'
            + '若页面没显示 Key，就改用本机 <code>cmd login</code> 后从 <code>~/.commandcode/auth.json</code> 取。'
            + '想走全自动流程，可用 SSH 隧道把本页映射到本机 <code>127.0.0.1</code> 再打开。</p>';
        $("#loginBox").innerHTML =
          warning
          + '<pre style="white-space:pre-wrap;word-break:break-all">' + esc(r.url) + '</pre>'
          + '<div class="row"><a href="' + esc(r.url) + '" target="_blank" rel="noopener"><button class="primary">打开登录页</button></a>'
          + '<button id="pollLogin">我已授权，检查</button></div>'
          + explanation;
        $("#pollLogin").onclick = async () => {
          await loadOverview();
          const count = state.overview?.accounts.length ?? 0;
          toast(count ? "当前共有 " + count + " 个账号" : "还没有账号，检查授权是否完成");
        };
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };

    $("#pasteSubmit").onclick = async (e) => {
      const btn = e.currentTarget;
      const value = $("#pasteValue").value.trim();
      if (!value) { toast("先粘贴回调地址或 API Key", "err"); return; }
      btn.disabled = true;
      try {
        await api("/admin/api/accounts", { method: "POST", body: { value, name: $("#pasteName").value } });
        toast("账号已添加");
        $("#pasteValue").value = "";
        $("#pasteName").value = "";
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };

    $("#importLocal").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api("/admin/api/accounts/import-local", { method: "POST", body: {} });
        toast("已导入");
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };
  }

  const body = $("#accRows");
  if (body) body.innerHTML = accountRows();
  bindAccountRowActions();
}

async function ensureModels() {
  if (state.models.length) return;
  try {
    const data = await api("/admin/api/models");
    state.models = data.models;
    state.prefs = data.prefs || {};
  } catch (err) { toast(err.message, "err"); }
}

function modelRows() {
  const f = state.modelFilter;
  const list = state.models.filter((m) => {
    if (f.q && !(m.id + " " + (m.name || "")).toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.category && m.category !== f.category) return false;
    if (f.plan && m.minimumPlan !== f.plan) return false;
    return true;
  });
  const body = list.map((m) => '<tr>'
    + '<td><div>' + esc(m.name || m.id) + '</div><div class="mono muted small">' + esc(m.id) + '</div></td>'
    + '<td class="small">' + fmt(m.context_length) + '</td>'
    + '<td class="small muted">' + (m.reasoningEfforts?.length ? esc(m.reasoningEfforts.join(", ")) : "—") + '</td>'
    + '<td class="small mono">' + (m.pricing ? money(m.pricing.inputCost) + " / " + money(m.pricing.outputCost) : "—") + '</td>'
    + '<td class="small"><span class="badge b-muted">' + esc(m.minimumPlan || "—") + '</span></td>'
    + '<td class="small muted">' + esc((m.supported_endpoints || []).join(", ")) + '</td>'
    + '</tr>').join("")
    + (list.length ? "" : '<tr><td colspan="6" class="pad muted">没有匹配的模型</td></tr>');
  return { html: body, count: list.length };
}

async function renderModels() {
  const sec = $("#secModels");
  sec.innerHTML = '<h2>模型目录<span class="spacer"></span><button id="refreshModels">刷新目录</button></h2><div class="pad muted">加载中…</div>';
  await ensureModels();
  const f = state.modelFilter;
  const categories = [...new Set(state.models.map((m) => m.category).filter(Boolean))];
  const plans = [...new Set(state.models.map((m) => m.minimumPlan).filter(Boolean))];

  sec.innerHTML = '<h2>模型目录<span class="spacer"></span><button id="refreshModels">刷新目录</button></h2>'
    + '<div class="pad"><div class="row">'
    + '<input id="mq" placeholder="搜索模型" style="max-width:260px" value="' + esc(f.q) + '">'
    + '<select id="mcat" style="max-width:180px"><option value="">全部类别</option>' + categories.map((c) => '<option value="' + esc(c) + '"' + (f.category === c ? " selected" : "") + '>' + esc(c) + '</option>').join("") + '</select>'
    + '<select id="mplan" style="max-width:180px"><option value="">全部套餐</option>' + plans.map((p) => '<option value="' + esc(p) + '"' + (f.plan === p ? " selected" : "") + '>' + esc(p) + '</option>').join("") + '</select>'
    + '<span class="muted small" id="mcount"></span>'
    + '</div></div>'
    + '<table><thead><tr><th>模型</th><th>上下文</th><th>思考档位</th><th>价格 /1M</th><th>最低套餐</th><th>端点</th></tr></thead>'
    + '<tbody id="mrows"></tbody></table>';

  const paint = () => {
    const { html, count } = modelRows();
    $("#mrows").innerHTML = html;
    $("#mcount").textContent = count + " / " + state.models.length;
  };
  paint();

  $("#mq").oninput = (e) => { state.modelFilter.q = e.target.value; paint(); };
  $("#mcat").onchange = (e) => { state.modelFilter.category = e.target.value; paint(); };
  $("#mplan").onchange = (e) => { state.modelFilter.plan = e.target.value; paint(); };
  $("#refreshModels").onclick = async () => {
    try {
      const r = await api("/admin/api/models/refresh", { method: "POST", body: {} });
      state.models = r.models;
      paint();
      toast("目录已刷新");
    } catch (err) { toast(err.message, "err"); }
  };
}

function keyRows() {
  const o = state.overview;
  const rows = (o?.apiKeys || []).map((k) => '<tr>'
    + '<td><div>' + esc(k.name) + '</div><div class="mono muted small">' + esc(k.prefix) + '…' + esc(k.suffix) + '</div></td>'
    + '<td>' + (k.enabled ? '<span class="badge b-ok">启用</span>' : '<span class="badge b-muted">停用</span>') + '</td>'
    + '<td class="small">' + fmt(k.requestCount) + '</td>'
    + '<td class="small muted">' + time(k.lastUsedAt) + '</td>'
    + '<td><div class="row">'
    + '<button data-kact="toggle" data-id="' + k.id + '" data-enabled="' + (!k.enabled) + '">' + (k.enabled ? "停用" : "启用") + '</button>'
    + '<button class="danger" data-kact="delete" data-id="' + k.id + '">删除</button>'
    + '</div></td></tr>').join("");
  return rows || '<tr><td colspan="5" class="pad muted">还没有 API Key</td></tr>';
}

function bindKeyRowActions() {
  document.querySelectorAll('#secKeys [data-kact]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        if (btn.dataset.kact === "toggle") {
          await api("/admin/api/keys/enabled", { method: "POST", body: { id, enabled: btn.dataset.enabled === "true" } });
        }
        if (btn.dataset.kact === "delete") {
          if (!confirm("删除这个 API Key？用它的客户端会立即失效。")) { btn.disabled = false; return; }
          await api("/admin/api/keys/" + id, { method: "DELETE" });
        }
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };
  });
}

function renderKeys() {
  const sec = $("#secKeys");
  if (!$("#keyRows")) {
    sec.innerHTML = '<h2>API 接入</h2>'
      + '<div class="pad"><div class="grid">'
      + '<div class="card"><h3>Base URL</h3><p class="mono">' + esc(state.boot.baseUrl) + '/v1</p></div>'
      + '<div class="card"><h3>OpenAI</h3><p class="mono">POST ' + esc(state.boot.baseUrl) + '/v1/chat/completions</p></div>'
      + '<div class="card"><h3>Anthropic</h3><p class="mono">POST ' + esc(state.boot.baseUrl) + '/v1/messages</p></div>'
      + '</div>'
      + '<div class="row" style="margin-top:14px"><input id="keyName" placeholder="客户端名称" style="max-width:240px">'
      + '<button class="primary" id="createKey">创建 API Key</button></div>'
      + '<div id="newKey" style="margin-top:12px"></div></div>'
      + '<table><thead><tr><th>名称</th><th>状态</th><th>请求数</th><th>最近使用</th><th></th></tr></thead>'
      + '<tbody id="keyRows"></tbody></table>';

    $("#createKey").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api("/admin/api/keys", { method: "POST", body: { name: $("#keyName").value } });
        $("#newKey").innerHTML = '<div class="card"><h3>新密钥（只显示这一次）</h3>'
          + '<p class="small muted">立刻复制到客户端配置里，之后列表只显示末六位。</p>'
          + '<pre style="margin-top:8px;word-break:break-all">' + esc(r.key) + '</pre></div>';
        $("#keyName").value = "";
        loadOverview();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };
  }
  const body = $("#keyRows");
  if (body) body.innerHTML = keyRows();
  bindKeyRowActions();
}

// ---------------------------------------------------------------- 用量视图

// Same thresholds the official overlay uses: green under 50, yellow under 80,
// red above.
function usageTone(percent) {
  if (percent >= 80) return "b-err";
  if (percent >= 50) return "b-warn";
  return "b-ok";
}

function usageBar(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  return '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
}

// Mirrors the CLI's formatDuration: "2d 3h", "5h 12m", "18m".
function formatCountdown(resetAt) {
  if (!resetAt) return "";
  const ms = Number(resetAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "即将重置";
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? days + "天 " + hours + "小时" : days + "天";
  if (hours > 0) return mins > 0 ? hours + "小时 " + mins + "分" : hours + "小时";
  return mins + "分";
}

function windowMeter(label, window) {
  if (!window) {
    return '<div class="row" style="justify-content:space-between"><span class="muted small">' + esc(label)
      + '</span><span class="muted small">上游未提供</span></div>';
  }
  const pct = Math.round(window.percent ?? 0);
  const countdown = window.resetAt ? ' · ' + formatCountdown(window.resetAt) + '后重置' : '';
  return '<div class="stack" style="gap:6px">'
    + '<div class="row" style="justify-content:space-between">'
    + '<span class="small">' + esc(label) + '</span>'
    + '<span class="badge ' + usageTone(pct) + '">' + pct + '%</span>'
    + '</div>'
    + usageBar(pct)
    + '<div class="muted small">已用 ' + fmt(window.used) + ' / ' + fmt(window.cap) + esc(countdown) + '</div>'
    + '</div>';
}

function quotaCard(entry) {
  const u = entry.usage;
  if (!u || !u.available) {
    const reason = u?.errors?.length ? u.errors.join("; ") : "还没有拉取过用量";
    return '<div class="card"><div class="row" style="justify-content:space-between">'
      + '<h3>' + esc(entry.account) + '</h3>'
      + '<button data-quota="refresh" data-id="' + entry.id + '">拉取用量</button></div>'
      + '<p style="margin-top:8px">' + esc(reason) + '</p></div>';
  }

  const c = u.credits ?? {};
  const overall = Math.round(c.usagePercent ?? 0);
  const renew = u.daysLeft === null || u.daysLeft === undefined
    ? ""
    : u.daysLeft === 0 ? " · 今天续费" : " · " + u.daysLeft + " 天后续费";
  const requests = u.requests === null || u.requests === undefined
    ? ""
    : fmt(u.requests) + (u.periodBasis === "billing-period" ? " 次请求（本月）" : " 次请求");

  return '<div class="card"><div class="stack" style="gap:12px">'
    + '<div class="row" style="justify-content:space-between">'
    + '<h3>' + esc(entry.account) + '</h3>'
    + '<div class="row"><span class="badge b-muted">' + esc(u.planName || u.planId || "未知套餐") + '</span>'
    + (u.status ? '<span class="badge ' + (u.status === "active" ? "b-ok" : "b-warn") + '">' + esc(u.status) + '</span>' : '')
    + '<button data-quota="refresh" data-id="' + entry.id + '">刷新</button></div></div>'
    + '<div class="stack" style="gap:6px">'
    + '<div class="row" style="justify-content:space-between"><span class="small">积分</span>'
    + '<span class="badge ' + usageTone(overall) + '">' + overall + '% 已用</span></div>'
    + usageBar(overall)
    + '<div class="muted small">剩余 ' + money(c.totalRemaining) + ' / 总额 ' + money(c.totalPool)
    + (u.extraCredits > 0 ? ' · 额外积分 ' + money(u.extraCredits) : '')
    + esc(requests) + esc(renew) + '</div></div>'
    + '<div class="stack" style="gap:10px;margin-top:4px">'
    + '<div class="muted small" style="text-transform:uppercase;letter-spacing:.06em">用量窗口</div>'
    + windowMeter("5 小时", u.windows?.fiveHour)
    + windowMeter("每周", u.windows?.weekly)
    + (u.sandboxAccess && u.sandbox ? windowMeter("本月云分钟", u.sandbox) : "")
    + '</div>'
    + (u.usageUrl ? '<p class="small"><a href="' + esc(u.usageUrl) + '" target="_blank" rel="noopener">在官网查看完整明细</a></p>' : '')
    + '</div></div>';
}

async function ensureQuota() {
  if (state.quota) return;
  try {
    state.quota = await api("/admin/api/usage");
  } catch (err) {
    toast(err.message, "err");
    state.quota = { accounts: [] };
  }
}

async function renderQuota() {
  const sec = $("#secQuota");
  if (!state.quota) sec.innerHTML = '<h2>用量</h2><div class="pad muted">加载中…</div>';
  await ensureQuota();
  const entries = state.quota?.accounts ?? [];

  sec.innerHTML = '<h2>用量<span class="spacer"></span><button id="refreshAllQuota">全部刷新</button></h2>'
    + '<div class="pad"><p class="small muted" style="margin-top:0">'
    + '按官网口径显示：积分是账单周期的总额度，5 小时与每周是限流窗口，云分钟是月度沙箱额度。'
    + '「刷新」才会请求上游，平时只显示上次结果。</p>'
    + '<div class="grid">' + (entries.length ? entries.map(quotaCard).join("") : '<div class="card"><p>还没有账号</p></div>')
    + '</div></div>';

  $("#refreshAllQuota").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api("/admin/api/usage/refresh", { method: "POST", body: {} });
      state.quota = null;
      await renderQuota();
      toast("用量已刷新");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  };

  sec.querySelectorAll('[data-quota="refresh"]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api("/admin/api/accounts/credits", { method: "POST", body: { id: btn.dataset.id } });
        state.quota = null;
        await renderQuota();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    };
  });
}

function usageRows() {
  const o = state.overview;
  const rows = (o?.usage || []).map((u) => '<tr>'
    + '<td class="small muted">' + time(u.at) + '</td>'
    + '<td class="mono small">' + esc(u.model) + '</td>'
    + '<td class="small">' + esc(u.source) + '</td>'
    + '<td>' + (u.ok ? '<span class="badge b-ok">ok</span>' : '<span class="badge b-err">失败</span>') + '</td>'
    + '<td class="small mono">' + (u.usage
      ? fmt(u.usage.inputTokens ?? u.usage.input_tokens) + " → " + fmt(u.usage.outputTokens ?? u.usage.output_tokens)
      : "—") + '</td>'
    + '<td class="small">' + fmt(u.latencyMs) + 'ms</td>'
    + '<td class="small muted">' + esc(u.account || "—") + '</td>'
    + '</tr>').join("");
  return rows || '<tr><td colspan="7" class="pad muted">还没有请求</td></tr>';
}

function renderUsage() {
  const sec = $("#secUsage");
  if (!$("#usageRows")) {
    sec.innerHTML = '<h2>使用记录<span class="spacer"></span><button id="refreshUsage">刷新</button></h2>'
      + '<table><thead><tr><th>时间</th><th>模型</th><th>来源</th><th>状态</th><th>tokens</th><th>耗时</th><th>账号</th></tr></thead>'
      + '<tbody id="usageRows"></tbody></table>';
    $("#refreshUsage").onclick = loadOverview;
  }
  const body = $("#usageRows");
  if (body) body.innerHTML = usageRows();
}

render();
loadOverview();
setInterval(() => { if (state.boot.authenticated) loadOverview(); }, 15000);
</script>
</body>
</html>`;
}
