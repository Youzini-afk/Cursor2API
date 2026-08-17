# 交接文档：Zeabur 部署 + 2API 管理后台

> 本文档面向接手的 AI agent / 开发者。
> 撰写时间：2026-08-17。仓库：`d:\project\cursor2api\Cursor2API`（fork 目标 `https://github.com/Youzini-afk/Cursor2API`）。
>
> **文档中标注 `已验证` 的结论来自实际读取源码（含文件与行号）；标注 `未验证` 的表示因环境限制无法执行命令确认。**

---

## 0. 交接摘要

| 阶段 | 状态 | 说明 |
| :-- | :-- | :-- |
| 一、Zeabur 容器化部署 | **代码已写完，未构建验证，未提交** | 5 个文件改动，见 §3 |
| 二、管理后台（概览 / 账号池 / 配置） | **仅完成设计，未写一行代码** | 完整设计与实施清单见 §5 起 |

### 阻塞原因

上一个工作环境的 shell 工具完全不可用：`execute_pwsh` 与后台进程工具对任意命令（包括 `echo hi`、`node --version`、`git --version`）均返回**空输出 + exit code 1**；后台进程标记为 running 但 20 秒后连输出文件都未写出。

因此以下动作**全部未执行**，需要接手方补做：

- `git add / commit / push`
- `docker build` / `docker run`
- `npm ci`、`npm run typecheck`、`npm test`
- 任何 `curl` 验证

文件读写工具正常，所以代码改动本身是完整落盘的。

---

## 1. 仓库与 Git 状态

- 工作区根目录：`d:\project\cursor2api`
- **实际仓库根目录：`d:\project\cursor2api\Cursor2API`**（`.git` 在这一层，注意不是工作区根）
- 当前分支：`master`（`.git/HEAD`）
- `origin` = `https://github.com/NGLSG/Cursor2API`（**上游仓库，不是用户的 fork**，见 `.git/config`）
- 用户 fork：`https://github.com/Youzini-afk/Cursor2API`

### 第一阶段的提交推送命令（需人工执行）

`AGENTS.md` 要求使用 Conventional Commits，且提交主题保持客观中立。

```powershell
cd d:\project\cursor2api\Cursor2API

# 先确认工作区没有其他无关改动
git status --short

git remote add fork https://github.com/Youzini-afk/Cursor2API

git add Dockerfile .dockerignore scripts/start-zeabur.mjs package.json README.md docs/handoff-admin-panel.md
git commit -m "feat: add Zeabur container deployment with Node bridge and Bun sidecar supervisor"
git push -u fork master
```

> `AGENTS.md` 还有一条硬性要求：**不得提交私有 Cursor 后端源、endpoint 路径或服务名**，这些只能放在 Worker secrets 或本地 env。本次改动不涉及，但后续写配置示例时要遵守。

---

## 2. 项目架构速查（`已验证`）

这个仓库同时维护**两条互不相通的运行路径**，接手前必须分清：

| 路径 | 入口 | 依赖 | 本次是否在范围内 |
| :-- | :-- | :-- | :-- |
| Cloudflare Worker | `worker/index.ts` + `wrangler.jsonc` | D1、R2、Durable Objects、ASSETS 绑定 | ❌ **明确不动** |
| 自建 sidecar | `sidecar/server.ts`（Bun）+ `scripts/cursor-sdk-local-agent-bridge.mjs`（Node） | 仅需 Cursor Key | ✅ 全部工作在此 |

### 2.1 关键背景：这是一个 fork，前端是上游残留

- `LICENSE`：Copyright (c) 2026 **Standard Agents**
- `package-lock.json` 根节点仍是 `api-for-cursor@0.1.0`，而 `package.json` 已是 `cursor2api@0.2.0`（改名时未重新生成 lock）
- `desktop/src/App.tsx:11`、`worker/index.ts:155` 硬编码上游仓库 `standardagents/composer-api`
- `src/chat.ts:67` 硬编码 `LOCAL_DEV_API_ORIGIN = "https://cursor-api.standardagents.ai"`

**`index.html` + `src/` 是上游商业产品（macOS 应用 + 托管服务）的官网落地页，不是自建用户的管理界面。** 它由 Worker 的 ASSETS 绑定分发（`worker/index.ts:105-108`），sidecar 完全不提供静态资源。`/chat` 页面（`src/chat.ts`）是唯一有实际功能的部分，但它服务的是托管场景。

**结论：本次管理后台是全新的 `admin/` 应用，不要试图改造 `src/`。**

### 2.2 sidecar 运行时事实

`sidecar/server.ts`（约 1180 行）：

| 事实 | 位置 |
| :-- | :-- |
| `HOST` 默认 `127.0.0.1` | `:70` |
| `DEFAULT_PORT = 8787` | `:72` |
| `LOCAL_API_KEY_LITERAL = "cursor-local"` | `:73` |
| `buildEnv()` 从 `process.env` 装配 `Env`；`DB` 与 `ASSETS` 被显式置为 undefined | `:97-110` |
| **配置名不一致**：`Env.CURSOR_SDK_BRIDGE_TIMEOUT_MS` 实际读取环境变量 `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS` | `:107` |
| `hasSdkBridge()` —— `CURSOR_SDK_BRIDGE_URL` 非空即走 SDK bridge 路径 | `:118-120` |
| `sessionAffinity()` 读 `x-session-affinity` / `x-opencode-session-id` / `x-opencode-session` / `idempotency-key` | `:127-137` |
| `sdkSessionOwner(apiKey)` = `` `cursor-key:${apiKey}` `` —— **SDK 会话按 Cursor Key 隔离** | `:143-145` |
| `responseStore` 是内存 Map，上限 512 | `:155-165` |
| **`resolveApiKey(request)`** —— 取 `x-api-key` 或 `Authorization: Bearer`；非空且不等于 `cursor-local` 则直接返回；否则回落 `process.env.CURSOR_API_KEY` | `:172-184` |
| `cursorSdkModelsUrl()` —— 把 `CURSOR_SDK_BRIDGE_URL` 的 pathname 改写为 `/models` | `:337-346` |
| 调 bridge 时 token 走 `Authorization: Bearer` | `:354-355` |
| `healthResponse(port)` 返回 `{ok, service:"api-for-cursor", host, modelCatalog, sdkVersion, baseUrl}` | `:295-304` |
| `route(request, port)` —— CORS 预检 → `/health` → 计算 `v1Path` → 各 `/v1/*` 路由 → **`return notFound()`** | `:1027-1073` |
| `toWebRequest` / `writeWebResponse` —— node:http 与 Web Request/Response 适配器 | `:1081-1140` |
| `main()` —— `server.listen(port, HOST)`，`parsePort()` 读 `PORT` | `:1149-1176` |

`resolveApiKey` 的全部调用点（改造双鉴权时需逐一处理）：

- `handleModels` `:424`
- `handleModel` `:431`
- `handleChatCompletions` `:440`
- `handleResponses` `:493`
- `handleAnthropicMessages` `:682`
- `handleSdkRoute(kind, request, prepared, apiKey, id, created, incrementalPrompt?)` `:753` 起（接收已解析的 apiKey）

### 2.3 SDK Bridge 运行时事实

`scripts/cursor-sdk-local-agent-bridge.mjs`（约 2520 行）：

| 环境变量 | 默认值 | 位置 |
| :-- | :-- | :-- |
| `CURSOR_SDK_BRIDGE_HOST` | `127.0.0.1` | `:15` |
| `CURSOR_SDK_BRIDGE_PORT` | `8792` | `:16` |
| `CURSOR_SDK_BRIDGE_TOKEN` | 空（空则不校验） | `:17` |
| `CURSOR_SDK_BRIDGE_MAX_JSON_BYTES` | 1 MiB | `:18` |
| `CURSOR_SDK_BRIDGE_MAX_AGENTS` | 128 | `:19` |
| `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS` | 180000 | `:20` |
| `CURSOR_SDK_BRIDGE_MAX_RUN_RETRIES` | 3 | `:21` |
| `CURSOR_SDK_BRIDGE_RETRY_BASE_DELAY_MS` | 500 | `:22` |
| `CURSOR_SDK_BRIDGE_AGENT_REFRESH_MS` | 45 min | `:23` |
| `CURSOR_SDK_WORKING_DIRECTORY` | `process.cwd()` | `:24` |

- 路由：`GET /health` → `{ok:true, agents:n}`（`:85`）；`POST /models`；`POST /sdk`；客户端工具回调路径
- token 校验：`bearerToken(request) !== bridgeToken` → 401（`:2458` 为 `bearerToken` 实现）
- 直接运行时自启动（`:38-45`）；`loadEnvFile` 有 `existsSync` 保护（`:2486-2489`）
- **必须用 Node 运行，不能换 Bun**：`@cursor/sdk` 依赖原生模块与 gRPC over HTTP/2；`package-lock.json` 中 `@cursor/sdk@1.0.27` 声明 `engines.node >= 22.13`

### 2.4 管理后台可复用的现成资产

这是最重要的一节 —— **不要从零造轮子**，Worker 那条路径已经有一半实现：

| 资产 | 位置 | 用途 |
| :-- | :-- | :-- |
| `accounts` 表结构（Cursor Key 密文 + iv + 后四位 hint） | `migrations/0001_init.sql:1-19` | 账号池表的基础 |
| `api_keys` 表结构（只存 `key_hash` 唯一索引 + `prefix` + `revoked_at`） | `migrations/0001_init.sql:21-36` | 网关 Key 表的基础 |
| `request_logs` 表结构（endpoint / model / status / chars / error / created_at / completed_at） | `migrations/0001_init.sql:38-56` | Dashboard 数据源 |
| `encryptText` / `decryptText`（AES-GCM）、`sha256Hex`、`randomToken(prefix)`、`apiKeyPrefix`、`accountIdForCursor` | `worker/crypto.ts` | 直接 import 复用 |
| **`verifyCursorApiKey(env, deps, apiKey)`** → `GET {CURSOR_API_BASE}/v1/me` → `CursorMe` | `worker/cursor.ts:29` | 添加账号时校验 Key 并回填 email / name |
| `CursorMe` 类型 `{apiKeyName, userId?, userEmail?, userFirstName?, userLastName?}` | `worker/types.ts:29+` | 同上 |
| `json` / `notFound` / `unauthorized` / `errorResponse` / `HttpError` / `openAiError` / `sseResponse` | `worker/http.ts` | 统一响应封装 |
| D1 版账号与 Key 读写逻辑（**参考实现，不可直接用**） | `worker/db.ts` | 抄逻辑，不抄 API |

两点注意：

1. `worker/db.ts` 用的是 D1 的 `prepare/bind/first/run` API，**与 `bun:sqlite` 不兼容**，只能作为逻辑参考。
2. `ENCRYPTION_KEY` 至少 16 字符，否则 `requireEncryptionSecret` 抛错（`worker/db.ts` 末尾）。sidecar 的 `buildEnv()` 给了默认值 `"api-for-cursor"`（`sidecar/server.ts:100`）—— **生产环境必须覆盖，否则等于用公开常量加密 Cursor Key**。
3. sidecar 已经在 import `worker/*` 的多个模块（`sidecar/server.ts:26-67`），新增 import 无障碍。唯一不能碰的是 `worker/sdk-bridge-container.ts`（它 import 了 `@cloudflare/containers`）。

---

## 3. 第一阶段已完成：Zeabur 容器化部署

### 3.1 改动的文件

| 文件 | 类型 | 说明 |
| :-- | :-- | :-- |
| `Dockerfile` | 新增 | 双运行时生产镜像 |
| `.dockerignore` | 新增 | 收窄构建上下文 |
| `scripts/start-zeabur.mjs` | 新增 | 前台双进程守护 |
| `package.json` | 改动 | 新增 `"start": "node scripts/start-zeabur.mjs"` |
| `README.md` | 改动 | 新增「Zeabur / 容器平台」小节；环境要求 Node `20+` → `22.13+` |

### 3.2 为什么这么设计

**为什么不能直接用平台自动识别部署**：根 `package.json` 原本没有 `start` 脚本；`npm run deploy` 是 `wrangler deploy`（目标是 Cloudflare）；`start:local` 会后台化并绑定 loopback；运行时同时需要 Node 和 Bun 两个运行时；仓库里原有的 `containers/cursor-sdk-bridge/Dockerfile` **只打包 bridge，不含 sidecar**，单独部署不会提供 `/v1/*`。

**为什么基底是 `node:22-trixie-slim`**：Bun 二进制是从 `oven/bun:1-debian` 复制过来的，而该镜像现在基于 **Debian trixie**（已通过 `https://raw.githubusercontent.com/oven-sh/bun/main/dockerhub/debian/Dockerfile` 确认：`FROM debian:trixie-slim` / `FROM debian:trixie`）。最初写的 bookworm 基底会导致复制过来的 bun 撞 glibc 版本不匹配，已改。两个基底必须保持同一 Debian 发行版。

**为什么用 Debian 而不是 Alpine**：`@cursor/sdk` 的平台包（`@cursor/sdk-linux-x64` / `-linux-arm64`）在 lock 中只声明 `os`/`cpu`、未声明 `libc`，且附带 `rg` 二进制，musl 环境风险更高。顺带一提，仓库原有的 `containers/cursor-sdk-bridge/Dockerfile` 用的是 `node:22-alpine`，属于潜在隐患，但本次未改动它。

**为什么不用 `server.mjs start` 作为容器入口**：它会 daemonize、把状态写进 `~/.cursor2api`、随机挑 bridge 端口。容器需要的正好相反 —— 一个前台守护进程，其生命周期等于容器生命周期。

### 3.3 `scripts/start-zeabur.mjs` 行为

启动顺序与语义：

1. 读 `PORT`（默认 8080）、`HOST`（默认 `0.0.0.0`）；`HOST` 为 loopback 时打印告警（平台探针会失败）
2. bridge 端口取 `CURSOR_SDK_BRIDGE_PORT`（默认 8792），**若与 `$PORT` 撞车自动 ±1**
3. token 取 `CURSOR_SDK_BRIDGE_TOKEN`，未设则 `randomBytes(24).toString("hex")` 生成
4. 用 `process.execPath`（Node）启动 bridge，绑 `127.0.0.1`
5. 轮询 bridge `GET /health`（默认上限 120s，可用 `BRIDGE_STARTUP_TIMEOUT_MS` 调）
6. 通过后启动 sidecar：`bun run sidecar/server.ts`，注入 `HOST` / `PORT` / `CURSOR_SDK_BRIDGE_URL`（`http://127.0.0.1:<port>/sdk`）/ `CURSOR_SDK_BRIDGE_TOKEN`
7. 轮询 sidecar `/health`（默认 60s，`SIDECAR_STARTUP_TIMEOUT_MS`）
8. 转发 `SIGTERM` / `SIGINT`；任一子进程意外退出 → 整体非零退出
9. **若 `CURSOR_SDK_BRIDGE_URL` 已被显式设置，则认为 bridge 是外部服务，只启动 sidecar**（支持拆成两个 Zeabur service 的拓扑）

子进程 `stdio: "inherit"`，日志直通平台。

### 3.4 未验证项（`未验证`，接手方必须补）

- `docker build` 从未执行 —— 镜像能否构建成功未知
- `npm ci --omit=dev` 从未执行 —— 见 §3.5 的 registry 风险
- `scripts/start-zeabur.mjs` **连语法检查都没跑过**（`node --check` 无法执行）。代码经过逐行静态复核，但请先跑一次
- sidecar 从未启动，`/health`、`/v1/models` 均未实测
- `@cursor/sdk` 在 Debian trixie / 目标架构上的原生依赖可用性，仅从 lock 的 `os`/`cpu` 字段推断

### 3.5 已知风险

1. **npm registry**：`package-lock.json` 中 `@cursor/sdk` 系列包的 `resolved` 指向 `registry.npmmirror.com`。构建环境必须能访问该镜像。`npm ci` 会沿用 lock 里的 `resolved` URL，**加 `--registry` 参数不会改写它**。若构建失败，需在本地用官方源重新生成 lock 后提交：`npm install --registry=https://registry.npmjs.org`。
2. **lock 与 package.json 名称不一致**：lock 根是 `api-for-cursor@0.1.0`，`package.json` 是 `cursor2api@0.2.0`。依赖清单本身一致，理论上 `npm ci` 不会因此失败，但未实测。
3. **Zeabur 挂 Volume 后无法零停机滚动部署**（官方 Best Practices 文档明确说明）。单实例场景可接受，部署时会有短暂中断。
4. `sidecar/server.ts:29` 与 `:52` 重复 import 了 `type CursorTextEvent`。Bun 会剥离类型 import 所以运行时无害（且现有 `bun run sidecar/server.ts` 本来就这么跑），但 `npm run typecheck`（`tsc --noEmit`）可能报重复声明。这是既有问题，非本次引入。

---

## 4. 已确认的设计决策（用户已拍板）

1. **双鉴权模型并存** —— 不破坏现有行为
2. **范围仅限自建 / Zeabur 路径**，Cloudflare Worker 完全不动
3. **一次做完**（不分阶段交付）
4. 技术栈由实施方决定 —— 下面 §5.1 给出已定方案，接手方可沿用

---

## 5. 第二阶段设计：管理后台

### 5.1 技术栈（已定）

| 层 | 选型 | 理由 |
| :-- | :-- | :-- |
| 持久化 | **`bun:sqlite`**（Bun 内置），DB 文件位于 `${DATA_DIR}/admin.db`，默认 `/app/data` | sidecar 本来就是 Bun，零新增依赖；单实例场景足够（内存态会话本来就要求单实例） |
| 管理 API | 挂在 `sidecar/server.ts` 内，前缀 **`/api/admin/v1`** | 与对外 `/v1` 彻底分开，边界清晰 |
| 管理鉴权 | 单管理员密码（env）+ **HMAC 签名 session cookie**（HttpOnly / SameSite=Strict） | 自建单管理员，JWT + refresh 双 token 属过度设计 |
| 前端 | **独立 `admin/` 应用：Vite + React 19 + TypeScript** | 与 `desktop/` 技术栈一致；不引入 UI 框架与图表库，图表用手写 SVG，控制镜像体积 |
| 运行时配置 | DB 单行 JSON + `revision` 乐观锁 + 进程内缓存 | 抄参考项目的双层配置模型，去掉多实例变更总线 |
| 静态托管 | 静态目录 + SPA fallback + **后端路径白名单** | 抄参考项目 `frontend.go` 的做法 |

不选 Postgres 的原因：sidecar 的 `responseStore`、模型缓存、SDK 会话缓存全是进程内存态，本来就必须单实例，引入外部 DB 不解决根本问题却增加运维面。若将来要多实例，再换驱动。

### 5.2 双鉴权模型（核心改造）

现状：`resolveApiKey()` 把客户端传来的 Key 直接透给 Cursor。

目标：按 Key 前缀分流。

```
请求携带的 Key
├─ 以 "cmp_" 开头  → 网关 Key：查库 → 校验未吊销 → 从账号池选账号 → 解密该账号的 Cursor Key → 记日志
└─ 其他（含 crsr_）→ 原样透传（现有行为，完全不变）
                     空 / "cursor-local" → 回落 process.env.CURSOR_API_KEY
```

前缀选 `cmp_` 是为了和 Worker 路径既有约定一致（`worker/db.ts` 中 `randomToken("cmp")`）。真实 Cursor Key 以 `crsr_` 开头，两者不会混淆。

**实施要点**：把 `resolveApiKey(request): string` 改造为

```ts
interface ResolvedAuth {
  cursorApiKey: string;
  accountId?: string;      // 仅网关 Key 路径有值
  gatewayKeyId?: string;   // 仅网关 Key 路径有值
}
async function resolveAuth(request: Request): Promise<ResolvedAuth | null>
```

注意它变成了 **async**，5 个调用点（§2.2 列出）都要 `await`。

**必须保留的语义**：`sdkSessionOwner(apiKey)` 用 Cursor Key 做 SDK 会话隔离键（`:143-145`）。网关 Key 路径下传入的是**选中账号的真实 Cursor Key**，这个行为要保持，否则不同账号会串会话。

**边界情况**：
- 网关 Key 有效但账号池为空 / 全部冷却中 → 503，错误码 `no_account_available`，消息要能区分「池子是空的」和「都在冷却」
- 网关 Key 已吊销 / 不存在 → 401（走 `unauthorized()`，Anthropic 路径走 `anthropicError`）
- 账号解密失败（`ENCRYPTION_KEY` 被换过）→ 500 并把该账号标记为 `decrypt_failed`，不要静默跳过

### 5.3 账号选择策略

按顺序过滤后排序：

1. 过滤：`enabled = 1` AND (`cooldown_until` IS NULL OR `cooldown_until` < now) AND 当前在途请求数 < `max_concurrent`
2. 排序：`priority` 升序（小的优先）→ `last_used_at` 升序（最久未用优先）
3. 选中后立即更新 `last_used_at`，并递增进程内的在途计数（请求结束后递减）

失败处理（指数退避，参数放运行时配置）：

- 请求失败 → `failure_count += 1`，`cooldown_until = now + min(base * 2^(failure_count-1), max)`，记 `last_error`
- 请求成功 → `failure_count = 0`，`cooldown_until = NULL`
- 401 / 认证类错误（可复用 bridge 里的 `isAuthenticationSDKError` 判定思路，见 `scripts/cursor-sdk-local-agent-bridge.mjs:2400` 附近）→ 直接标 `auth_status = 'reauth_required'` 并禁用，不要反复重试

在途计数只在内存（单实例前提），进程重启后归零 —— 这是可接受的，但要在代码注释里写明。

### 5.4 数据模型

**放在哪里**：新建 `sidecar/admin/schema.sql`，启动时用 `PRAGMA user_version` 做版本化增量执行。

> ⚠️ **不要把这些 SQL 放进仓库根的 `migrations/`**。那个目录是 wrangler 的 D1 迁移目录（`package.json` 里 `db:migrate:local` / `db:migrate:remote` 会执行它），混进 SQLite 专用语句会污染 Worker 部署。

表设计（字段命名沿用 `migrations/0001_init.sql` 的风格，便于对照）：

```
accounts
  id                            TEXT PK
  label                         TEXT           -- 管理员自定义备注名
  cursor_user_id                TEXT
  cursor_email                  TEXT
  cursor_name                   TEXT
  cursor_api_key_ciphertext     TEXT NOT NULL
  cursor_api_key_iv             TEXT NOT NULL
  cursor_api_key_hint           TEXT           -- 只存后 4 位
  enabled                       INTEGER NOT NULL DEFAULT 1
  priority                      INTEGER NOT NULL DEFAULT 1
  max_concurrent                INTEGER NOT NULL DEFAULT 4
  auth_status                   TEXT NOT NULL DEFAULT 'active'   -- active | reauth_required | decrypt_failed
  failure_count                 INTEGER NOT NULL DEFAULT 0
  cooldown_until                TEXT
  last_error                    TEXT
  last_used_at                  TEXT
  last_verified_at              TEXT
  created_at / updated_at       TEXT NOT NULL

gateway_keys                     -- 对应 Worker 的 api_keys，但不绑定单一 account
  id            TEXT PK
  prefix        TEXT NOT NULL
  key_hash      TEXT NOT NULL UNIQUE           -- sha256，明文只在创建时返回一次
  name          TEXT NOT NULL
  enabled       INTEGER NOT NULL DEFAULT 1
  account_id    TEXT                            -- 可选：绑定固定账号；NULL = 使用整池
  rpm_limit     INTEGER                         -- 可选
  created_at    TEXT NOT NULL
  last_used_at  TEXT
  revoked_at    TEXT

request_logs                     -- 在 0001_init.sql 基础上扩展
  id / endpoint / model / status / error / created_at / completed_at
  account_id        TEXT           -- 透传模式下为 NULL（注意：不能沿用 Worker 的 NOT NULL 约束）
  gateway_key_id    TEXT
  prompt_chars / completion_chars  INTEGER NOT NULL DEFAULT 0
  latency_ms        INTEGER
  first_token_ms    INTEGER
  cursor_agent_id / cursor_run_id  TEXT

runtime_settings                 -- 单行
  key         TEXT PK             -- 固定 'gateway'
  value       TEXT NOT NULL       -- JSON
  revision    INTEGER NOT NULL
  updated_at  TEXT NOT NULL

admin_sessions                   -- 可选；若用无状态签名 cookie 则不需要
```

索引至少要有：`request_logs(created_at DESC)`、`request_logs(account_id, created_at DESC)`、`gateway_keys(key_hash)`、`accounts(enabled, priority)`。

### 5.5 请求日志采集

抄参考项目的思路：**不用内存计数器，写流水 + SQL 聚合**，重启不丢数据。

- 请求开始时插入一行（status = `pending`）
- 结束时 `UPDATE`（status、latency_ms、first_token_ms、completion_chars、error、completed_at）
- 写入必须是**异步批量**的，不能阻塞 SSE 流。建议内存 ring buffer + 定时 flush（参考项目参数：`batchSize 256`、`flushInterval 250ms`，见 `config.example.yaml:114-124`）
- 保留期由运行时配置控制，定时清理旧行

**SSE 场景特别注意**：`/v1/chat/completions` 等是流式响应，`writeWebResponse`（`sidecar/server.ts:1117-1140`）逐块写出。首 token 时间要在流的第一个 chunk 处采集，不要等流结束才算。

### 5.6 概览指标

从 `request_logs` 聚合，加 **15 秒结果缓存**（参考项目做法，`?refresh=1` 绕过缓存）：

- 请求总数、成功率、错误数（按时间桶出趋势）
- 平均首 token 延迟、平均总耗时
- 按模型 Top N、按账号分布
- 账号池健康：可用 / 冷却中 / 已禁用 / 需重新认证 的计数
- 最近 N 条错误
- 支持 period = 24h / 7d / 30d

Cursor 侧**没有额度查询 API**，所以不要设计「余额 / 配额」类指标（参考项目有，是因为 Grok 那边有）。

---

## 6. 管理 API 契约

全部挂在 `/api/admin/v1`。除 `auth/login` 外都需要有效 session cookie。统一响应封装建议 `{ "data": ... }` / `{ "error": { "code", "message" } }`。

```
POST   /api/admin/v1/auth/login          { password }        → set-cookie
POST   /api/admin/v1/auth/logout
GET    /api/admin/v1/auth/me                                 → { authenticated: true }

GET    /api/admin/v1/overview?period=24h&refresh=1

GET    /api/admin/v1/accounts
POST   /api/admin/v1/accounts            { cursorApiKey, label? }   -- 落库前先 verifyCursorApiKey
GET    /api/admin/v1/accounts/:id
PATCH  /api/admin/v1/accounts/:id        { enabled?, priority?, maxConcurrent?, label? }
DELETE /api/admin/v1/accounts/:id
POST   /api/admin/v1/accounts/:id/verify                     -- 重新校验 Key 并刷新 email/name
POST   /api/admin/v1/accounts/:id/reset-cooldown
PATCH  /api/admin/v1/accounts/batch      { ids, patch }

GET    /api/admin/v1/gateway-keys
POST   /api/admin/v1/gateway-keys        { name, accountId?, rpmLimit? }  → 明文仅此一次返回
PATCH  /api/admin/v1/gateway-keys/:id    { name?, enabled?, rpmLimit? }
DELETE /api/admin/v1/gateway-keys/:id

GET    /api/admin/v1/settings                                → { config, revision }
PUT    /api/admin/v1/settings            { config, revision } -- revision 不匹配返回 409

GET    /api/admin/v1/logs?page=&status=&model=&accountId=
GET    /api/admin/v1/logs/:id
```

### 运行时可配置项（`runtime_settings.value` 的 JSON 结构）

```jsonc
{
  "pool":     { "strategy": "priority-lru", "cooldownBaseMs": 30000, "cooldownMaxMs": 1800000, "maxFailuresBeforeDisable": 10 },
  "bridge":   { "runTimeoutMs": 180000 },
  "logs":     { "retentionDays": 14, "flushIntervalMs": 250, "batchSize": 256 },
  "security": { "sessionTtlHours": 168 }
}
```

启动期不可变的东西（`PORT`、`HOST`、`DATA_DIR`、`ADMIN_PASSWORD`、`ENCRYPTION_KEY`、bridge 地址与 token）**保持在环境变量**，不要放进这张表。这是参考项目双层配置模型的关键分界。

---

## 7. 前端页面（`admin/`）

```
admin/
├── package.json          -- 需生成 lockfile，见 §9 注意事项
├── vite.config.ts        -- base: "/admin/"，dev 时 proxy /api 与 /v1 到 127.0.0.1:8787
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx
    ├── app.tsx           -- 路由 + 布局 + 登录态守卫
    ├── api.ts            -- fetch 封装；401 统一跳登录
    ├── styles.css
    └── pages/
        ├── login.tsx
        ├── overview.tsx  -- 指标卡 + 手写 SVG 趋势图 + 账号健康 + 最近错误
        ├── accounts.tsx  -- 列表 / 添加（含 Key 校验回填）/ 启停 / 优先级 / 并发 / 重置冷却 / 删除
        ├── keys.tsx      -- 网关 Key 签发（明文一次性展示）/ 停用 / 删除
        ├── settings.tsx  -- 运行时配置表单，带 revision 冲突提示
        └── logs.tsx      -- 分页筛选 + 详情抽屉
```

页面挂载路径建议 `/admin/*`（不要占用站点根，避免和将来可能启用的 Worker 前端语义冲突）。

---

## 8. sidecar 改造点（精确插入位置）

### 8.1 新增模块

```
sidecar/admin/
├── schema.sql        -- 建表 + PRAGMA user_version 版本化
├── db.ts             -- bun:sqlite 连接、迁移执行、预编译语句
├── auth.ts           -- 密码校验（node:crypto scrypt）、签名 cookie 签发/校验、登录限流
├── settings.ts       -- 运行时配置读写 + revision 乐观锁 + 进程内缓存
├── accounts.ts       -- 账号池 CRUD、选择策略、冷却与失败计数
├── keys.ts           -- 网关 Key CRUD（只存 hash）
├── logs.ts           -- 异步批量写入 + 分页查询 + 保留期清理
├── overview.ts       -- 聚合查询 + 15s 缓存
├── routes.ts         -- /api/admin/v1 路由分发
└── assets.ts         -- admin/dist 静态托管 + SPA fallback
```

### 8.2 修改 `sidecar/server.ts`

1. **`route()`（`:1027`）**：在 `/health` 判断之后、`v1Path` 计算之前插入

   ```ts
   if (pathname === "/api/admin/v1" || pathname.startsWith("/api/admin/v1/")) {
     return await handleAdminRoute(request, pathname);
   }
   ```

2. **`route()` 末尾的 `return notFound()`（`:1073`）**：改为静态资源兜底

   ```ts
   // 后端路径白名单：这些前缀永远不能被 SPA fallback 吞掉
   if (isBackendPath(pathname)) return notFound();
   return await serveAdminAsset(request, pathname);
   ```

   `isBackendPath` 需要涵盖 `/v1`、`/health`、`/api`。这是抄参考项目 `frontend.go:78-90` 的做法 —— 不加白名单的话 API 的 404 会被 SPA 的 `index.html` 吞掉，调试会非常痛苦。

3. **`resolveApiKey`（`:172-184`）**：按 §5.2 改造为 async 的 `resolveAuth`，同时保留原函数作为透传分支的内部实现。

4. **5 个调用点**（`:424` / `:431` / `:440` / `:493` / `:682`）：改为 `await resolveAuth(request)`，并把 `accountId` / `gatewayKeyId` 往下传给日志层。

5. **`healthResponse`（`:295-304`）**：可以加上 `adminEnabled` 与账号池可用数，方便平台探针之外的排查。注意 `/health` 是公开端点，**不要泄露账号明细**。

6. **`main()`（`:1163`）**：`server.listen` 之前初始化 DB 与迁移；注册 `SIGTERM` 时 flush 日志缓冲。

---

## 9. Dockerfile 与 Zeabur 变更

### 需要加的构建阶段

在现有 `FROM oven/bun:1-debian AS bun` 之后、runtime 阶段之前插入前端构建：

```dockerfile
FROM node:22-trixie-slim AS admin
WORKDIR /admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
RUN npm run build
```

runtime 阶段追加：

```dockerfile
COPY --from=admin /admin/dist ./admin/dist
COPY sidecar ./sidecar          # 已有，注意 sidecar/admin/*.sql 也要进去
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
```

### 注意事项

1. `admin/package-lock.json` **必须先在本地 `npm install` 生成并提交**，否则 `npm ci` 会失败。或者构建阶段改用 `npm install`（牺牲可复现性）。
2. `.dockerignore` 当前**没有**排除 `admin`，所以新目录能进构建上下文 —— 但它排除了根级 `dist`，请确认 `admin/dist` 的产物是在镜像内生成的（上面的写法是），不是从上下文拷贝的。
3. `.dockerignore` 排除了 `**/*.test.ts`，若给 admin 写测试注意这一点。
4. `.dockerignore` 排除了根级 `tsconfig.json`（`sidecar/tsconfig.json` 不受影响，它没有 `extends`）。若 `admin/tsconfig.json` 要 extends 根配置，需调整。
5. Zeabur 侧要在 Service 上挂 Volume 到 `/app/data`，并接受「挂 Volume 后无零停机部署」。

---

## 10. 环境变量总表

| 变量 | 必需 | 默认 | 说明 |
| :-- | :-- | :-- | :-- |
| `PORT` | — | 8080 | **由 Zeabur 注入，不要手填** |
| `HOST` | — | `0.0.0.0` | 容器内必须是 `0.0.0.0` |
| `DATA_DIR` | — | `/app/data` | SQLite 文件位置，需挂 Volume |
| `ADMIN_PASSWORD` | **是** | — | 未设置时管理 API 必须返回 503，见 §11 |
| `ADMIN_SESSION_SECRET` | 建议 | 随机生成 | 未设则每次重启登录态失效 |
| `ENCRYPTION_KEY` | **是** | ⚠️ `api-for-cursor` | 加密账号池里的 Cursor Key，**必须覆盖**，建议 32+ 随机字节 |
| `CURSOR_SDK_BRIDGE_TOKEN` | — | 启动时随机生成 | Sidecar ↔ Bridge 鉴权 |
| `CURSOR_SDK_BRIDGE_HOST` | — | `127.0.0.1` | 不要对外暴露 |
| `CURSOR_SDK_BRIDGE_PORT` | — | 8792 | 与 `$PORT` 撞车会自动 ±1 |
| `CURSOR_SDK_BRIDGE_URL` | — | 空 | 设了就表示用外部 bridge，不再拉起本地 bridge |
| `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS` | — | 180000 | 注意 sidecar 内部字段名是 `..._TIMEOUT_MS`（见 §2.2） |
| `CURSOR_API_KEY` | — | 空 | 透传模式的回落 Key。**公网部署建议不设**，见 §11 |
| `BRIDGE_STARTUP_TIMEOUT_MS` | — | 120000 | 守护脚本等待 bridge 健康的上限 |
| `SIDECAR_STARTUP_TIMEOUT_MS` | — | 60000 | 同上，等 sidecar |

---

## 11. 安全要求（不可妥协项）

1. **管理后台是公网暴露的。** `ADMIN_PASSWORD` 未设置时，管理 API 必须返回 503 并在日志里说明原因 —— **绝对不能允许无鉴权访问**。不要提供默认密码。
2. `ENCRYPTION_KEY` 的默认值是公开常量 `"api-for-cursor"`（`sidecar/server.ts:100`）。账号池落库前必须校验它已被覆盖且长度足够，否则拒绝写入并明确报错。
3. 网关 Key 只存 `sha256`，明文仅在创建响应里返回一次。
4. 日志、错误消息、`/health` 响应中**不得出现完整 Cursor Key**，只用后 4 位 hint。
5. Session cookie：`HttpOnly`、`SameSite=Strict`、`Path` 收窄到 `/api/admin`，HTTPS 环境下加 `Secure`。
6. 登录接口必须限流（参考项目对登录失败有速率限制并记录来源 IP）。
7. 同时设置 `CURSOR_API_KEY` 且不加外层鉴权 = 任何人都能白嫖你的账号（`resolveApiKey` 的回落逻辑，`:183`）。公网部署建议不设该变量，让客户端自带 Key 或走网关 Key。
8. Bridge 只监听 loopback，不要在平台上对外开放它的端口。

---

## 12. 验证清单（接手方必做）

第一阶段（部署）：

```powershell
cd d:\project\cursor2api\Cursor2API
node --check scripts/start-zeabur.mjs      # 语法，从未跑过
npm ci                                      # 确认 npmmirror 可达
npm run typecheck                           # 注意 §3.5 第 4 条的既有问题
docker build -t cursor2api .
docker run --rm -p 8080:8080 -v cursor2api-data:/app/data cursor2api
curl http://127.0.0.1:8080/health
```

第二阶段（管理后台）闭环验证：

1. 未设 `ADMIN_PASSWORD` 时，管理 API 返回 503
2. 设置后能登录，错误密码被限流
3. 添加账号：填入真实 `crsr_` Key → 自动回填 email / name → 列表出现该账号，只显示后 4 位
4. 签发网关 Key `cmp_xxx`，明文只出现一次
5. **用 `cmp_xxx` 调 `/v1/chat/completions`** → 成功，且日志里记录了 account_id 与 gateway_key_id
6. **用真实 `crsr_` Key 调同一端点** → 成功（证明透传模式未被破坏，这是回归重点）
7. 禁用唯一账号后用 `cmp_xxx` 调用 → 503 `no_account_available`
8. 概览页数字与 `request_logs` 实际行数一致
9. 改配置 → 保存 → 生效；用旧 revision 再保存 → 409
10. 容器重启后账号与 Key 仍在（Volume 生效）；SSE 流式响应正常且首 token 时间被记录

---

## 13. 参考项目对照：`D:\project\grok2api\grok2api-chenyme`

Go + React 实现的同类后台，以下是值得照搬的四个设计点（含原始位置）：

| 设计 | 位置 | 要点 |
| :-- | :-- | :-- |
| 静态目录 + `NoRoute` SPA fallback + 后端路径白名单 | `backend/internal/transport/http/frontend.go:13-90` | 比 `go:embed` 灵活，可纯 API 模式运行；`/assets/` 用 immutable 长缓存，其余 `no-cache` |
| 管理 API 前缀 + 独立鉴权中间件，与对外 API 彻底分离 | `backend/internal/transport/http/server.go:141-171` | 管理走 JWT，对外走 Client Key，互不相干 |
| 双层配置：启动期 YAML/env 不可变 + 运行期 DB 单行 JSON + revision 乐观锁 + 变更总线 | `relational/settings_repository.go:17,33-85`、`config.example.yaml` | 本项目单实例，去掉总线即可 |
| 审计流水异步批量落库 + SQL 聚合 + 短缓存 | `config.example.yaml:114-124`、`relational/dashboard_repository.go:21-60`、`application/dashboard/service.go:17,80` | 成功率、首 token、tok/s 全从原始列算，不存聚合值；15s TTL 缓存，`?refresh=1` 绕过 |

账号池字段设计可对照 `backend/internal/domain/account/account.go`（`Enabled` / `Priority` / `MaxConcurrent` / `FailureCount` / `CooldownUntil` / `AuthStatus` / 加密 token 字段）。

**不要照搬的部分**：多 provider 抽象、出口节点/代理池、质量守护 sidecar、Redis 运行态、额度恢复探测（Cursor 无额度 API）、媒体资产管理。这些是 Grok 场景特有的，搬过来只会增加复杂度。

---

## 14. 交接注意事项汇总

1. **仓库根是 `Cursor2API` 子目录**，不是工作区根。相对路径容易搞错。
2. `migrations/` 是 wrangler D1 专用，SQLite schema 放 `sidecar/admin/schema.sql`。
3. `worker/sdk-bridge-container.ts` 是唯一 import 了外部包（`@cloudflare/containers`）的 worker 模块，sidecar 侧**不要 import 它**。
4. Bridge 必须 Node、sidecar 必须 Bun，这个约束写在 README 和 CHANGELOG 里，有原因（原生模块 + HTTP/2），不要"优化"成单运行时。
5. 本次所有工作都不应触碰 `worker/`、`src/`、`desktop/`、`wrangler.jsonc`。唯一例外是**只读复用** `worker/crypto.ts`、`worker/cursor.ts`、`worker/http.ts`、`worker/types.ts`。
6. 提交遵循 Conventional Commits；推送到 `fork` remote，不要推 `origin`（那是上游）。
