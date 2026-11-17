# Command Code Relay

把 **Command Code CodingPlan 订阅** 暴露成 **OpenAI 兼容** 与 **Anthropic 兼容** 的 API，自带中文管理页面，适合用 Docker 部署在内网。

参考项目：[re-proxy/trae-relay-web](https://github.com/re-proxy/trae-relay-web)（它把 Trae 订阅变成 OpenAI API）。本仓库把同样的思路用在 Command Code 上，协议来自官方 `command-code` CLI 的逆向分析，没有照抄命令行工具的代码。

---

## 为什么要走 CLI 网关

Command Code 有两套入口，容易混淆：

| 入口 | 谁在用 | CodingPlan 能用吗 |
| --- | --- | --- |
| `https://api.commandcode.ai/provider/v1/*` | 官方文档里的 Provider API | **不能**。文档写明「Every plan except the Go plan has API access」，Go（$10 那档）没有 API Key 权限。 |
| `https://api.commandcode.ai/alpha/generate` | 官方 `command-code` CLI 的模型网关 | **能**。订阅额度就是在这里计的。 |

所以 Relay 走 `/alpha/generate`，把它的 wire 格式翻译成标准协议。请求带的头部与 CLI 一致（`x-command-code-version`、`x-session-id`、`x-project-slug` 等），上游看到的就是一次正常的 CLI 调用。

## 功能

- **三种入口协议**：`/v1/chat/completions`（含 SSE 流式、工具调用、`stream_options.include_usage`）、`/v1/messages`（含流式 content block、`tool_use`、可选 extended thinking）和 `/v1/responses`（标准 Responses 对象与事件流）。
- **模型目录**：合并上游 `/provider/v1/models` 与客户端目录（上下文长度、思考档位、按 1M token 的价格、最低套餐、支持的端点），管理页可搜索、筛选、刷新。
- **账号池**：多账号轮询 + 每账号并发闸门；凭据被上游拒绝时把账号标记为「需重新登录」并跳过，但不删除、不丢密钥，重新登录即自动恢复。
- **多 API Key**：为每个客户端单独发密钥，可停用/启用/删除，只显示后六位。
- **使用记录**：最近 500 次请求的模型、来源协议、token、耗时、账号、成败。
- **余额接口**：`GET /v1/balance` 返回订阅积分合计与完整性标记，给下游 router 查额度用。
- **中文管理页**：账号、模型、API 接入、使用记录四个标签页，15 秒自动刷新。
- **凭据加密**：账号 API Key 用 AES-256-GCM 加密落在数据文件里，密钥来自 `RELAY_MASTER_KEY`。

## 部署

### 前置条件

- Docker Engine 20.10+ 与 Compose v2（`docker compose` 子命令；老的 `docker-compose` v1 也能用，把下文命令里的空格换成连字符）
- 一个对外可访问的端口，默认 **8317/TCP**
- 部署机器能出网访问 `api.commandcode.ai` 与 `commandcode.ai`

不需要 Node.js，也不需要本机装 `command-code` CLI——镜像自带全部运行时代码，没有 npm 依赖。

### 三步启动

```sh
git clone https://github.com/Costiae/CmdCode-Go-Relay.git cmdcd-relay
cd cmdcd-relay
sh scripts/init-env.sh
```

`init-env.sh` 生成 `.env`，里面只有两项：管理密码与主密钥。脚本不会覆盖已存在的 `.env`。用 `cat .env` 看管理密码并保存好。

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=30 relay
```

浏览器打开 `http://服务器IP:8317`，用 `.env` 里的 `RELAY_ADMIN_PASSWORD` 登录。

> `0.0.0.0` 是监听地址，浏览器要填服务器的实际 IP。服务器本机可用 `http://127.0.0.1:8317`。

### 没有 OpenSSL 时生成主密钥

```sh
docker compose run --rm --no-deps relay keygen
```

容器入口就是服务器本体，带 `keygen` 参数时只打印一串主密钥并退出，不读 `.env`、不连网。把输出的值填进 `.env` 的 `RELAY_MASTER_KEY`。

**主密钥一旦有账号接入就不能再换**，换了已存凭据全部解不开。备份时 `.env` 与 `relay-data` volume 必须一起备。

也可以手动复制模板：

```sh
cp .env.example .env
docker compose run --rm --no-deps relay keygen   # 填 RELAY_MASTER_KEY
# 再设一个不同的 RELAY_ADMIN_PASSWORD
```

### 健康检查与自检

```sh
curl http://127.0.0.1:8317/health
# {"status":"ok"}
```

Compose 里已配了 `HEALTHCHECK`，`docker compose ps` 会显示 `healthy`。

部署后建议跑一次自检，它会逐项检查配置、数据文件、上游连通性、每个账号的凭据和余额、API Key 状态：

```sh
docker compose exec relay node src/server.mjs doctor
```

```
cmdcd-relay doctor

configuration
  ok    RELAY_ADMIN_PASSWORD is set
  ok    RELAY_MASTER_KEY decodes to 32 bytes
  ...
upstream
  ok    model catalog reachable — 117 models
accounts
  ok    main: credential accepted — your-username
  ok    main: credits — $4.50 (individual-go)
```

有 FAIL 时退出码为 1，可以直接串进部署脚本。它只读取状态，不会改账号或凭据。

### 不用 Docker（直接跑）

```sh
cp .env.example .env          # 填 RELAY_ADMIN_PASSWORD
node src/server.mjs keygen    # 生成主密钥，填进 .env
npm start                     # 或 node src/server.mjs
```

需要 Node.js 22 以上。同样没有 npm 运行时依赖。

### 端口与网络

改宿主端口就改 `docker-compose.yml` 的 `ports`，例如 `9000:8317`，客户端相应换成 9000。

内网其他机器打不开时依次检查：用的是服务器实际内网 IP（不是 `0.0.0.0`）、宿主防火墙放行该端口、`docker compose ps` 里端口映射确实生效。

### HTTPS / 反向代理

放在 Nginx、Caddy 或群晖反代后面时，**回调地址必须能被浏览器访问到**，否则登录回调会失败。两种做法：

**做法一：让 Relay 知道自己的公网地址**（推荐）

```dotenv
RELAY_PUBLIC_URL=https://relay.example.com
```

设置后登录回调固定用这个地址。没有设置时，Relay 从请求头推断，会读 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，所以反代要把这两个头透传：

```nginx
location / {
    proxy_pass http://127.0.0.1:8317;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;

    # SSE 必须关掉缓冲，否则流式响应会攒到最后一次性吐出
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding on;
}
```

Caddy 一行搞定（自动 HTTPS）：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8317
}
```

**做法二：不用公网回调**，用「粘贴回调地址」。见下节。

> **SSE 流式必须有 `proxy_buffering off`**。反代缓冲会让客户端等到整段生成结束才收到内容，看起来像"卡住了"，这是最常见的部署问题。

### 群晖 / 威联通 / unRAID

用「项目」或 Container Manager 的 Compose 功能，把本仓库放进去，`.env` 里填两项必需配置即可。数据卷映射到宿主机目录更方便备份：

```yaml
    volumes:
      - /volume1/docker/cmdcd-relay:/data
```

### 更新

```sh
git pull --ff-only
docker compose up -d --build
```

`.env` 与 volume 保留，账号和密钥不受影响。

停止：`docker compose down`。
**不要用 `docker compose down -v`**，`-v` 会删掉数据卷，账号全部丢失。

同一份数据只能跑一个实例。

## 接入账号

管理页「账号」标签页有三种方式，任选其一：

**1. 浏览器登录（推荐）** — 点「生成登录链接」，在新标签页完成 Command Code 登录。授权成功后官方页面会跳回 Relay 的 `/callback`，账号自动写入。

**2. 粘贴回调地址** — 如果 Relay 跑在 NAS 或内网机器上、本机浏览器打不开回调端口，就把授权后地址栏里的完整 URL（形如 `http://127.0.0.1:53xxx/callback?apiKey=...&state=...`）复制出来，粘贴到「粘贴回调 / API Key」里提交。也可以直接粘贴在 Studio 里创建的 API Key。

**3. 本机导入** — 在已经跑过 `cmd auth login` 的机器上启动 Relay，点「导入本机登录态」，直接读 `~/.commandcode/auth.json`。

添加后点「验证」确认连通性，「余额」拉取当期积分。

> 回调地址默认由请求的 Host 推断；放在反向代理后面时，设置 `RELAY_PUBLIC_URL`，或确保 `X-Forwarded-Proto` / `X-Forwarded-Host` 被透传。

## 客户端配置

先在「API 接入」页创建 API Key（只显示一次）。

| 客户端字段 | 值 |
| --- | --- |
| Base URL | `http://服务器内网IP:8317/v1` |
| API Key | 管理页创建的 `sk-cmd-...`（不是管理密码） |
| Model | `/v1/models` 里的模型 ID，例如 `deepseek/deepseek-v4.1-flash` |

OpenAI 兼容客户端：

```sh
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer sk-cmd-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

Anthropic 兼容客户端把 Base URL 指向同一地址，SDK 会自动打 `/v1/messages`：

```sh
curl http://127.0.0.1:8317/v1/messages \
  -H "x-api-key: sk-cmd-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

`POST /v1/responses` 返回标准 Responses 对象（`object:"response"`、`output` 里的 `message` / `function_call` 项、`output_text`），流式时发出 `response.created` → `response.output_text.delta` → `response.completed` 事件序列，`sequence_number` 连续编号。`input` 支持字符串、`message` 项，以及 `function_call` / `function_call_output` 组成的工具轮次；`instructions` 会作为 system prompt 转发。

## 余额接口

```sh
curl http://127.0.0.1:8317/v1/balance -H "Authorization: Bearer sk-cmd-..."
```

```json
{
  "balance": 5.5,
  "unit": "credits",
  "currency": "USD",
  "complete": true,
  "accounts": [{ "account": "main", "plan_id": "individual-go", "balance": 5.5 }]
}
```

`balance` 是所有启用账号的积分合计，`complete` 为 false 表示有账号查询失败，此时不要把它当成完整额度。这里返回的是**积分**，不是美元余额。

## 配置项

全部可选，除前两项外都有默认值。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RELAY_ADMIN_PASSWORD` | — | **必填**，管理页密码 |
| `RELAY_MASTER_KEY` | — | **必填**，32 随机字节的标准 Base64 |
| `RELAY_PORT` | `8317` | 监听端口 |
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_PUBLIC_URL` | 空 | 对外访问地址，用于拼登录回调 |
| `RELAY_DATA_FILE` | `data/relay.json` | 数据文件（Docker 内为 `/data/relay.json`） |
| `RELAY_UPSTREAM_BASE` | `https://api.commandcode.ai` | 上游网关 |
| `RELAY_STUDIO_BASE` | `https://commandcode.ai` | 登录页所在站点 |
| `RELAY_CLI_VERSION` | `1.89.2` | 伪装给上游的 CLI 版本，过旧会被拒绝 |
| `RELAY_CLI_ENVIRONMENT` | `production` | 伪装给上游的 CLI 环境标识 |
| `RELAY_PROJECT_SLUG` | `relay` | 伪装给上游的项目标识 |
| `RELAY_MAX_CONCURRENT` | `4` | 每账号并发上限 |
| `RELAY_ACCOUNT_QUEUE_MS` | `60000` | 全部账号满载时的排队上限 |
| `RELAY_MAX_OUTPUT_TOKENS` | `32000` | 单次输出上限 |
| `RELAY_UPSTREAM_TIMEOUT_MS` | `120000` | 上游超时 |
| `RELAY_CATALOG_TTL_MS` | `900000` | 模型目录缓存时间 |
| `RELAY_SESSION_TTL_MS` | `43200000` | 管理页登录态有效期 |
| `RELAY_USAGE_LIMIT` | `500` | 保留的使用记录条数 |

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 启动即退出并打印 `config: ...` | `.env` 缺 `RELAY_ADMIN_PASSWORD` 或 `RELAY_MASTER_KEY`，或主密钥不是 32 字节 |
| 管理页登录失败 | 用的是管理密码，不是 API Key |
| API 返回 401 | 先确认 `sk-cmd-...` 正确且未被停用；若 message 来自上游，说明上游拒绝了账号凭据 |
| 账号显示「需重新登录」 | 上游拒绝了这个账号的凭据。账号不会被自动删除，重新走一次登录或粘贴新密钥即可恢复，恢复后自动解除暂停 |
| API 返回 503 `account_needs_reauth` | 所有启用的账号都被上游拒绝过。打开管理页重新登录任一账号 |
| API 返回 403 | 上游额度不足或该模型不在你的套餐里 |
| API 返回 429 | 上游限流，稍后重试 |
| API 返回 503 `no_enabled_account` | 没有启用账号，去管理页启用 |
| API 返回 503 `account_concurrency_limit` | 所有账号并发已满，调高 `RELAY_MAX_CONCURRENT` 或排队时间 |
| 登录页授权后回调打不开 | 用「粘贴回调地址」方式，把地址栏完整 URL 提交 |
| 不确定哪里出问题 | 跑 `docker compose exec relay node src/server.mjs doctor`，它会把配置、上游、账号、密钥逐项列出 |
| 改了 `.env` 没生效 | `docker compose up -d --force-recreate`（`restart` 不会重读 env） |
| 报「CLI 已过时」/ `upgrade_required` | 上游提高了最低 CLI 版本。错误信息里会给出要求版本，把 `.env` 的 `RELAY_CLI_VERSION` 改到不低于它，再 `docker compose up -d --force-recreate` |
| 流式响应要等全部生成完才出字 | 反代开了缓冲。加 `proxy_buffering off;`（见「HTTPS / 反向代理」） |

## 支持范围

支持：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、SSE 流式、工具调用（三种协议各自的原生工具形状）、图片输入（`data:` URL）、思考档位、模型别名、账号多开、余额查询。

不支持：托管工具（`web_search` 等由上游执行的工具）、音频、严格 JSON Schema 的 `response_format`、`/provider/v1/systemone` 决策模型。Anthropic 的 `thinking` 只在客户端显式请求时返回，且不带签名。

## 命令行子命令

镜像入口就是服务器本体，不带参数时启动服务；另有两个子命令：

| 命令 | 用途 |
| --- | --- |
| `... keygen` | 打印一串 32 字节主密钥并退出。不读 `.env`、不连网 |
| `... doctor` | 逐项自检配置、存储、上游、账号凭据、API Key，有 FAIL 时退出码 1 |

```sh
docker compose exec relay node src/server.mjs doctor
docker compose run --rm --no-deps relay keygen
```

## 上游变更时怎么跟

Relay 靠伪装 CLI 走网关，所以上游升级时通常只需要改一两个配置，不用改代码：

| 上游变化 | 处理 |
| --- | --- |
| 提高最低 CLI 版本 | 调 `.env` 的 `RELAY_CLI_VERSION`。报错信息会直接给出要求版本 |
| 新增模型或调整价格 | 无需操作。目录每 15 分钟从上游刷新一次，管理页点「刷新目录」可立即更新 |
| 新增/改名模型别名 | 无需操作。别名随目录下发，`/v1/models` 会列出 |
| 改了生成接口的请求或流事件格式 | 需要改代码：`src/upstream.mjs`（发请求）与 `src/wire.mjs`（解析流、转消息） |
| 改了谁可以调 API 的档位规则 | 无需操作。Relay 只用 CodingPlan 本来就有的网关权限 |

## 数据与升级

数据包括账号凭据、API Key 哈希、模型偏好与使用记录，都在 Docker 的 `relay-data` volume 里。**备份 volume 与 `.env` 两样都要**，缺一不可。

```sh
git pull --ff-only
docker compose up -d --build
```

`docker compose down -v` 会删掉 volume，别在有账号时用。

## 测试

```sh
npm test
```

三套测试，全部离线，不访问真实上游、不需要订阅：

| 套件 | 覆盖 |
| --- | --- |
| `test/run.mjs` | 起一个真实服务进程 + mock 上游，跑完整链路：鉴权、账号接入、模型目录与别名、三种协议的流式与非流式、工具调用与多轮回放、中途断流、错误透传、并发闸门、CORS 作用域、密钥生命周期、重启后持久化 |
| `test/pool-unit.mjs` | 账号池失败策略：429 不停用、401 标记重认证、暂停账号被跳过且保留密钥、恢复后自动解除 |
| `test/admin-harness.mjs` | 在最小 DOM 环境里执行管理页脚本，验证首屏与四个标签页都能渲染 |

`test/run.mjs` 里还覆盖了 `keygen` 与 `doctor` 两个子命令（含上游不可达、主密钥错误等失败路径）。

## 验证记录

分清「已验证」与「未验证」，别把前者当成后者：

**已验证**

- 模型目录：真实上游返回 117 个模型（`/provider/v1/models` 与 `?view=client` 合并），含上下文长度、思考档位、价格、最低套餐、别名。
- 请求形状：`/v1/chat/completions`、流式 `/v1/chat/completions`、带 tools 的 chat、`/v1/messages`、`/v1/responses` 五种形状都真实打到 `api.commandcode.ai`，全部被网关接受——都只返回 401 鉴权错误，**没有一个被 400 参数校验拒绝**。这证明请求体字段与上游 schema 一致。
- 登录入口：官方 `studio/auth/cli` 链接对 `callback` 与 `state` 参数返回 302 跳到 `/signin`，回调参数被完整保留。
- 配置校验：缺 `RELAY_ADMIN_PASSWORD` / `RELAY_MASTER_KEY`、或主密钥不是 32 字节时，启动即退出并给出具体原因。
- `keygen` 子命令在没有任何配置时也能输出 32 字节主密钥。
- 数据文件权限 `600`、数据目录 `700`，嵌套路径自动创建。
- 镜像载荷自足：只拷 `package.json` + `src/` 到空目录，无 `node_modules`、无 `.env`，用 Docker 那套环境变量可直接启动并服务管理页。
- **Docker 镜像在 CI 里真实构建并运行通过**：GitHub Actions 的 `docker` job 执行 `docker build`、`docker run`、等待 `/health` 就绪、`curl /` 确认管理页、校验 `keygen` 输出格式，全部 success；`test` job 跑完三套离线测试。见 [Actions 记录](https://github.com/Costiae/CmdCode-Go-Relay/actions)。

**未验证**

- **真实账号的生成请求**。没有 CodingPlan 凭据，所以端到端「发一条消息拿到模型回复」尚未实测。这是唯一剩下的验证项，部署后第一条消息即可确认。
- **真实账号的余额与额度窗口**。`/v1/balance` 的解析逻辑按逆向得到的字段写，但没有真实订阅数据核对。

若首次请求失败，先看 `docker compose logs relay`，再对照「常见问题」。把报错贴到 issue 即可。

## 协议说明

抓到的上游约定（`command-code` 1.89.2）：

- 生成：`POST /alpha/generate`，body 为 `{config, memory, taste, skills, permissionMode, mode, promptCache, params}`；`params` 里是 `{model, messages, tools, system, max_tokens, stream, reasoning_effort?}`。
- 流事件：NDJSON，`text-delta` / `reasoning-delta` / `tool-call` / `finish`（带 `totalUsage`）/ `error`。
- 工具 schema：`{name, description, input_schema}`。
- 消息：`user`（`text` / `image`）、`assistant`（`text` / `reasoning` / `tool-call`）、`tool`（`tool-result`）。
- 身份：`GET /alpha/whoami`；额度：`/alpha/billing/credits` 与 `/alpha/billing/subscriptions`；目录：`/provider/v1/models`。

`mode` 必须是 `agent` / `learning` / `custom-agent` / `custom-agent-create` / `title-gen` / `tool-desc` / `compact` / `vision` 之一，`config` 必填（工作目录、日期、平台等）。这些细节写错会得到 400，README 里的字段说明就是照此实现的。

## 许可

MIT。仅供个人在自有订阅上自用；请遵守 Command Code 的服务条款。
