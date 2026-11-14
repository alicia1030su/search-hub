# 真实搜索联调执行方案（v0.1.3，基线 4dddd19）

日期：2026-11-14 ｜ 目标：取得**真实外部证据**，不增加本地测试计数
前提：本机无 Docker Engine、无任何 Provider Key、未获授权连接 44475

> 本文只回答三件事：**现在能做什么**、**卡在谁身上**、**做到什么程度才算通过**。
> 任何没有 run URL + 真实 URL 的「已验证」都不成立。

---

## 0. 一页结论

| 能力 | 可立即执行？ | 阻塞点 | 通过标准 |
|---|---|---|---|
| Tavily 真实联调 | **是**（需 1 个 Secret） | `PROVIDER_LIVE` 环境无 Secret | `provider-live.yml` 绿色 + 2 条真实 https URL |
| 博查 Bocha 真实联调 | **是**（需 1 个 Secret） | 同上 | 同上 |
| Brave 真实联调 | 否 | 需订阅 Key **且** Runner 网络可达 | 同上 |
| SearXNG 通用网页联调 | **是**（二选一：自建实例 / 本地容器） | 一个启用了 JSON 的实例 | §4.4 的 A（接口可用）+ B（真实上游/故障上报）；域名数只作覆盖广度记录 |
| 旧版 44475 兼容 | 否 | **未授权连接受控旧服务器** | 协议识别清单全部核对完 |
| 模型厂商 | 否 | 任一家厂商 Key | 摘要带真实引用 |
| AC-13 Agent 客户端 | 否 | 桌面客户端 | 真实加载 3 个 SKILL.md |

**唯一能立刻推动状态变化的是 Tavily 或博查任意一个 Secret。** 其余都需要新的外部条件。

---

## 1. `provider-live.yml` 现状核对（只读）

### 1.1 运行参数

| 项 | 值 | 说明 |
|---|---|---|
| 触发 | `workflow_dispatch` only | **没有** push / PR 触发，密钥不会因为日常提交被用到 |
| 输入 `provider` | `auto` / `tavily` / `bocha` / `brave`，默认 `auto` | `auto` = 只调用"有 Secret 的那几个" |
| 运行环境 | `environment: provider-live` | Secret 必须建在该 Environment 下，不是仓库级 |
| 权限 | `contents: read` | 无写权限，无法改仓库 |
| 并发 | 同 ref 不并发，`cancel-in-progress: false` | 真实调用不被打断 |
| 超时 | 15 分钟 | 两个 query × 20s 超时，余量充足 |
| 产物 | `provider-*.log`，保留 7 天 | 脚本已脱敏；仅调试用，不是长期证据 |

### 1.2 Secrets 要求（**当前状态：0 个**）

```text
$ gh api repos/alicia1030su/search-hub/environments
provider-live

$ gh api .../environments/provider-live/secrets
0   # 一个都没有

$ gh secret list
(empty)
```

需要的最小集合（每个都是可选的，缺了就 SKIP 而不是通过）：

| Secret 名 | 用于 | 最小权限 |
|---|---|---|
| `TAVILY_API_KEY` | `--provider tavily` | 一个 Tavily 账号的 API Key（`tvly-...`），Basic 计划即可 |
| `BOCHA_API_KEY` | `--provider bocha` | 博查开放平台 Key，**需有余额**（403 = 余额不足，不是 Key 失效） |
| `BRAVE_API_KEY` | `--provider brave` | Brave Search API 订阅令牌（免费档有限速） |

### 1.3 脚本本身的行为（已核对）

- Key 只从环境变量读（本 PR 已移除 `--key` 传参，避免出现在进程 argv 中），**不打印、不落盘**；日志只写 `LIVE: credential loaded (value never printed)`。
- 无 Key → **exit 2（SKIP）**，不是 0，CI 不会把跳过当成通过。
- 通过条件：**两个 query 都必须返回 ≥1 条结果**，每条 URL 必须是 `https`、非 `example.com`/`localhost` 等占位域，标题非空，同一响应内无重复 URL。
- 两个 query：中文 `中国 新能源汽车 产业 最新政策`（`freshness=month`）+ 英文 `typescript monorepo best practices`。**中文 query 是刻意设计的**——如果厂商对中文支持差，这里会直接暴露。
- 失败会打印 `code` 与 message，不含 Key。

### 1.4 无 Secret 时的真实行为（已实测）

2026-11-14 在分支上手动触发 `provider-live.yml -f provider=auto`（Environment 中 0 个 Secret）：

```text
SKIP: tavily has no secret in the provider-live environment
SKIP: bocha  has no secret in the provider-live environment
SKIP: brave  has no secret in the provider-live environment
##[error]No provider secret is configured for this run
Process completed with exit code 1.
```

Run: <https://github.com/alicia1030su/search-hub/actions/runs/43613257891>

**这是刻意设计**：没有 Key 时工作流失败，而不是绿色。因此不存在"没配 Key 却显示通过"的假证据。

> 一个真实局限：`freshness` 只对中文 query 生效，英文 query 不带时间过滤。这是有意为之（避免旧结果被误判为失败），但也意味着**时间范围过滤只在一半样本上被验证**。

---

### 1.5 真实 Key 的六条泄漏路径（逐一核对，不以"不在 argv"为终点）

| # | 路径 | 当前真实状况 | 处置 |
|---|---|---|---|
| 1 | **进程 argv / 命令回显** | 已移除 `--key`；脚本只从环境变量读取。CI 命令是 `provider-live.mjs --provider <name>` | 已消除 |
| 2 | **异常信息** | `safe-fetch.ts` 对上游错误正文调用 `redactSecrets(...)`，传入 `authorization` / `x-api-key` / `x-subscription-token` 的值；`ProviderError` 只带 code + 已脱敏 message。`expectObject` 等本地错误不含响应体 | 已有防护；`provider-live.mjs` 的所有输出再经 `scrub()` 兜一层 |
| 3 | **作业日志** | 脚本每条输出（含第三方标题/URL/异常）都经 `scrub()`；工作流用 `::add-mask::` 注册精确值；GitHub 自身对 Secret 值做掩码 | 三层防护，见下方残余风险 |
| 4 | **artifact 文件** | GitHub 的日志掩码**不覆盖** artifact 文件内容。原工作流直接上传 `provider-*.log` | **已修**：上传前用 `scrub-provider-logs.mjs` 就地脱敏（同一 `redactText` 实现），上传的是脱敏后文件 |
| 5 | **子进程** | 脚本在纯 `node` 启动时会 re-exec 一次到 `tsx`：`spawnSync` 继承 `process.env`（Key 必须传到子进程）、`stdio: inherit`、argv 不含 Key。CI 直接用 `pnpm exec tsx`，**不产生该子进程** | 已把命令改为 `pnpm exec tsx`；本地 re-exec 只经环境变量，脚本输出同样脱敏 |
| 6 | **第三方响应回显** | 厂商可能在错误页、标题、URL、snippet 里回显请求头/凭据。`redactSecrets` 覆盖精确值 + Bearer 前缀 + `sk-`/`tvly-`/`sh_` 形态；`scrub()` 额外覆盖 URL 编码与 base64 变体 | 双层脱敏；**残余风险见下** |

#### 残余风险（不宣称绝对安全）

- `redactText` 只能匹配**精确值及已知变换**（Bearer、URL 编码、base64、已知前缀）。如果厂商把 Key 做大小写折叠、分片、加盐哈希、自定义编码后回显，脱敏无法识别。
- 因此：**Key 必须使用专用、最小额度、可随时吊销的测试 Key**；不要用生产 Key。
- artifact 保留 7 天仍是一个可下载副本；不需要调试时应手动删除，或把 `retention-days` 降到 1。
- `::add-mask::` 与 GitHub 掩码只对**精确值**生效，不对变换值生效。
- 结论：**"Key 不在 argv"只是消除了一条路径，不等于绝对安全**。上线前仍应人工抽查一次真实 run 的日志与 artifact。

### 1.6 `provider-live` Environment 安全边界（2026-11-15 实测）

配置前（证据）：

```json
{"name":"provider-live","can_admins_bypass":true,
 "protection_rules":[],"deployment_branch_policy":null}
```

即：**任何分支**都能引用该环境的 Secret，且管理员可绕过保护规则；`secrets` 数量为 0。

配置后（证据）：

```json
{"name":"provider-live","can_admins_bypass":false,
 "protection_rules":[{"type":"branch_policy"}],
 "deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}
```

```text
branch policies:
main    branch
```

实证：在非 main 分支 `docs/real-search-validation-plan` 上手动触发 `provider-live.yml`，job 在 5 秒内失败，Actions 批注为：

```text
Branch "docs/real-search-validation-plan" is not allowed to deploy to provider-live due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

Run: <https://github.com/alicia1030su/search-hub/actions/runs/43616441125>

`main` 本身受分支保护（5 个必需检查、禁止强推/删除）。因此真实 Provider Secret **只能被受保护的 main 分支上的作业读取**。管理员绕过已关闭。

> 注意：`workflow_dispatch` 可以在 UI 上选择分支，但如果所选分支不是 `main`，Environment 规则会在 job 启动前拒绝，Secret 不会被注入。这正是预期的边界。

## 2. Tavily / 博查最小真实联调方案

### 2.1 需要你做的事（3 步，全程不接触 Key 明文）

1. 打开 <https://github.com/alicia1030su/search-hub/settings/environments>，确认 `provider-live` 环境已存在（**已存在，无需新建**）。
2. 点该环境右侧 **Add environment secret**：
   - Name 必须**逐字符**是 `TAVILY_API_KEY` 或 `BOCHA_API_KEY`（大小写、下划线都不能错，代码按名字取）。
   - Value 直接粘贴 Key。
3. 如果想在 Secret 之外再加一道保险：给该 Environment 加 **Required reviewers**（最多 6 人），这样工作流启动前会被你手动批准。

**不要**：把 Key 发到聊天、写进 issue/PR、提交到任何文件、贴到日志。Secret 一旦保存，GitHub 只回显名字，不回显值，这是预期行为。

### 2.2 需要我做的事（你完成后执行）

```bash
# 只调用有 Secret 的那个（auto 也行，但单点更清晰）
gh workflow run provider-live.yml -f provider=tavily --repo alicia1030su/search-hub
gh run watch <run-id> --repo alicia1030su/search-hub
```

### 2.3 通过标准（逐条可核对）

| # | 条件 | 在哪看 |
|---|---|---|
| 1 | job 结论 `success` | Actions run 页面 |
| 2 | 日志含 `LIVE PASSED — ... answered both queries with real https results` | step "Call the configured providers" |
| 3 | 中文 query 返回 ≥1 条，URL 为真实 `https://` 域名 | 同上，`[zh-current-affairs]` 段 |
| 4 | 英文 query 返回 ≥1 条 | `[en-tech]` 段 |
| 5 | 日志中**不含** Key 的任何前缀/后缀 | 全文搜索 `tvly-`、`sk-` 应只出现在脱敏占位 |
| 6 | 产物 `provider-tavily.log` 内容与日志一致、无明文 | artifact 下载检查 |

6 条全部满足后，才允许改 `catalog.ts` 的 `verification: "documented" → "live_tested"`，并在 `docs/provider-matrix.md` 贴 run URL。

### 2.4 常见失败与判定（避免误判）

| 现象 | 真实含义 | 处理 |
|---|---|---|
| `SKIP: tavily has no secret` | Secret 名字不对或没建在该 Environment | 核对名字，重跑 |
| `401` / `Unauthorized` | Key 无效或复制时带了空格 | 重新生成 Key |
| `403`（博查） | **余额不足**，不是 Key 失效 | 充值；不要标记为 `live_tested` |
| `432`（Tavily） | 计划额度上限 | 换计划或等额度 |
| `429` | 限速 | 等 1 分钟重跑，不要改测试 |
| 中文 query 返回 0 条 | 厂商中文索引弱 / query 太窄 | **允许**，但此时只能写「英文已验证，中文弱」，不能写「Tavily 已完全验证」 |
| `timeout` | Runner 到厂商网络问题 | 重跑一次；仍失败则记录为环境限制 |

### 2.5 证据等级：Adapter 真实验证 ≠ 全链路真实验证

`provider-live.mjs` 直接调用 `getAdapter(name).search(...)`，**绕过**了 API 路由、鉴权、Key 池调度、RRF 融合、缓存、模型管线、MCP 与 Skills。它只能证明"这个适配器能向真实厂商发请求并解析响应"。

| 等级 | 名称 | 实际验证了什么 | 允许的表述 |
|---|---|---|---|
| L0 | 契约测试 | 用本地 fake 验证请求/响应形状 | 「适配器实现符合文档」 |
| L1 | **Adapter 真实联调** | `provider-live.mjs` 对真实厂商端点发起 2 个 query | 「Tavily **适配器**已完成真实联调」；该 provider 可升 `live_tested` |
| L2 | REST 端到端 | 通过平台 `POST /api/search`，走完 DB → 调度 → 融合 → 响应 | 「REST 搜索链路已用真实源验证」 |
| L3 | REST + MCP + Skills | 官方 MCP 客户端调用 + 3 个 SKILL.md 加载执行 | 「全链路已验证」 |

**明确禁止的推论**：
- L1 通过 → ❌ 不得写「REST / MCP 全链路已完成联调」。
- L1 通过 → ❌ 不得把 AC-13（真实 Agent 客户端）从 BLOCKED 改成 PASS。
- L1 通过 → ❌ 不得把 HN 或 Mock 结果算进通用网页搜索覆盖。
- 只有 L2 实际跑过才能升级 AC-02 相关描述；只有 L3 才能讨论全链路。

L2 / L3 需要 Key 配置到**平台实例**（不只是 CI Environment），并单独设计验证脚本；本轮不实施。

---

## 3. 旧版 44475 兼容需求梳理（**纯只读，未连接**）

### 3.1 已知事实（来自本仓库代码与文档，不是对旧服务的观测）

| 项 | 已知 | 来源 |
|---|---|---|
| 旧服务端口 | 44475（用户口述 + 历史配置） | 会话上下文 |
| 可能存在的接口 | REST `/api/search`、MCP `/mcp` | 本项目自身的 API 形状，**不是**对旧版的确认 |
| 鉴权 | 未知（可能无鉴权 / Bearer / session cookie） | — |
| 返回信封 | 未知（本适配器同时容忍 `{results}` 与 `{data:{results}}`） | `legacy-search-hub.ts` |
| 来源字段 | 未知（`provider`/`source`/`sources` 全部按"有则复制、无则不填"处理） | 同上 |
| 版本 | 未知 | — |

**结论：这是一个"按本项目 API 形状猜出来"的兼容层，任何一句"已接入旧版"都不成立。**

### 3.2 非破坏性协议识别方案（按顺序，**未授权不执行**）

**这是协议识别，不是兼容性验收。** 目标是确认旧服务"长什么样"，而不是让它跑业务流量。

#### 副作用声明（必须先读）

| 动作 | 可能的副作用 | 约束 |
|---|---|---|
| `GET /api/health` | 通常无；可能增加一条访问日志 | 无状态读取，最安全 |
| `GET /api/openapi.json` / `GET /` | 访问日志 | 纯元数据，不触发业务 |
| MCP `initialize` | 可能创建会话、写入会话表、占用一个连接槽 | 只做握手，**不调用 `tools/call`** |
| **任何搜索调用** | **可能消耗上游 API 额度、产生计费、更新调用统计/仪表盘、写入结果缓存、触发限流或熔断、写审计日志** | **默认不做**；只有在你明确授权"允许一次真实搜索及其副作用"后，才用专用低权限 token 执行 1 次，并记录时间、query 与额度变化 |
| 构造错误请求（空 query / limit=0） | 可能写错误日志、计入失败率 | 默认不做；仅在授权范围内执行 |

> 所以"只读"只适用于元数据步骤。**搜索调用不是只读操作**，不能因为它是 GET/POST 查询就当作无副作用。

#### 阶段 1：元数据识别（无业务副作用，仍需授权连接）

| 步骤 | 动作 | 目的 | 判定 |
|---|---|---|---|
| R0 | `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://<host>:44475/api/health` | 服务是否活着、是否为本项目 | 200 + `{"status":"ok"}` → 同源 |
| R1 | `curl -sS -m 5 http://<host>:44475/api/openapi.json` | 一次拿到全部路径与字段 | 有 `paths["/api/search"]` → REST 存在 |
| R2 | `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://<host>:44475/mcp` | MCP 端点是否存在 | 404/405 → 无 MCP；400/406 → 可能有 |
| M1 | 仅 `initialize`（`tools/list` 都不调用）：`-H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' http://<host>:44475/mcp` | 确认协议版本与工具清单来源 | SSE `data:` 含 `serverInfo` → MCP 可用 |
| A1 | 记录 R0/R1/R2 的 `WWW-Authenticate`、`Set-Cookie`、401/403 状态码 | 鉴权方案 | `Bearer` / `Cookie` / 无 |

**阶段 1 结束时只允许写"发现某端点存在 / 需要某种鉴权"，不允许写"兼容已验证"。**

#### 阶段 2：最小业务探测（**需单独授权，默认跳过**）

| 步骤 | 动作 | 前置条件 | 必须记录 |
|---|---|---|---|
| E1 | 一次 `POST /api/search`，`{"query":"protocol-probe","limit":1}`，使用专用低权限 token | 明确授权 + 已知额度影响 | 时间、响应顶层键名（`results` / `data` / `items`）、`status`、`errors` 结构 |
| E2 | 记录单条结果字段 | E1 返回 200 | 是否有 `provider` / `source` / `sources` / `siteName`，用于来源归因 |
| E3 | 一次 `GET /search?q=protocol-probe&format=json`（仅当 R1 无 `/api/search`） | 明确授权 | 路径与方法差异 |
| E4 | 一次错误请求（空 query / limit=0） | 明确授权 | 错误码与错误体结构，是否被计入失败率 |

阶段 2 未完成，**不得**把 `search-hub-legacy` 标为 `live_tested`，也不得宣称 REST 或 MCP 全链路已联调。

**判定矩阵：**

| 探测结果 | 适配器配置 | 状态 |
|---|---|---|
| `/api/search` 200 + `{results}` | 默认（`transport: rest`, `path: /api/search`） | 可升 `live_tested` |
| `/api/search` 200 + `{data:{results}}` | 默认即可（已兼容） | 可升 `live_tested` |
| 只有 `/search?q=` | `transport: rest`, `path: "/search"`（**但适配器只发 POST JSON，需要改代码**） | 需新 PR |
| 只有 MCP | 当前**不支持**，需独立 `search-hub-legacy-mcp` 适配器 | 需新 PR |
| 需要 cookie 会话 | 当前只支持 Bearer | 需新 PR |
| 无鉴权 | `requiresKey: false`，不填 Key | 可升 |

### 3.3 本轮明确不做

- 不连接、不探测、不重启、不修改 44475 生产服务。
- 不执行任何搜索调用：它可能消耗 API 额度、更新统计/缓存、写审计日志（见 §3.2 副作用声明）。
- 不在文档里写任何"已接入/已兼容"结论。
- 不为了"让它通"而改 SSRF 白名单或降级校验。

---

## 4. SearXNG 通用网页搜索联调可行性

### 4.1 为什么 SearXNG 是最现实的通用网页来源

- **无 Key**：不需要凭证，也就能立刻在 CI 或本机跑。
- **元搜索**：结果来自 Google/Bing/DDG 等多个引擎，能真正代表"通用网页搜索"。
- **可自建**：一个容器即可，不依赖第三方账号。

### 4.2 硬性前提

| 前提 | 说明 | 不满足会怎样 |
|---|---|---|
| `search.formats: [json]` | 默认只开 `html`，JSON 必须显式开启 | 适配器报 `blocked: HTTP 403`（已专门映射） |
| 实例可达 | 跨服务器要放行端口 | `timeout` / `network` |
| 出站可达上游引擎 | 容器本身要能访问 Google/Bing 等 | 返回 0 条（引擎被墙或限流） |
| 未被上游封禁 | 公共实例常被 CAPTCHA | 结果稀疏或 0 条 |
| 建议：自建 + 限流 | 不限定并发会被上游识别 | 间歇 429 |

### 4.3 三种可行部署（按推荐度）

**A. 本机 Docker（推荐，但本机 Docker 不可用）**

```bash
docker run -d --name searxng-local -p 8080:8080 \
  -v "$PWD/searxng:/etc/searxng" searxng/searxng:latest
# settings.yml 关键段
# search:
#   formats: [html, json]
```

**B. 独立测试服务器（最现实）**

在一台能出网的 Linux 上跑同一容器，只暴露给测试机 + GitHub Runner（或仅测试机）。这需要你提供一台机器或一个已有实例地址。

**C. 公共实例（不推荐做验收）**

公共实例随时可能关 JSON 或挂掉，**不能作为验收依据**；只能当"快速冒烟"。

### 4.3.1 本机实测：公共实例不可用（2026-11-14）

```text
control (api.github.com)          200
searx.be/search?format=json       000 (timeout 10s)
search.bus-hit.me/...             000 (timeout)
priv.au/...                       000 (timeout)
searxng.site/...                  000 (timeout)
```

对照 `api.github.com` 返回 200，说明不是 URL 写错，而是本机网络到这些公共实例不可达。
即使可达，公共实例通常也关闭 JSON 或对数据中心 IP 返回 CAPTCHA。**因此公共实例只能当冒烟，不能作为验收依据；验收必须用自建实例。**

### 4.4 验收条件（严格定义"通用网页搜索已验证"）

判定分三类：**接口可用性（必须全部满足）**、**覆盖广度（只记录、不作通过门槛）**、**行为正确性（必须全部满足）**。

#### A. 接口可用性（硬门槛）

| # | 条件 | 判定 |
|---|---|---|
| A1 | 实例 `/search?q=test&format=json` 返回 200 且是 JSON | 基础可用 |
| A2 | 中文 query（`中国 新能源汽车 产业 最新政策`）返回 ≥5 条有效结果 | 中文覆盖 |
| A3 | 英文 query（`typescript monorepo best practices`）返回 ≥5 条 | 英文覆盖 |
| A4 | 每条结果 URL 为 `https`、非占位域、标题非空、同一响应内不重复 | 有效结果 |
| A5 | 通过平台 `POST /api/search`（`providers: [searxng]`）拿到同类结果 | 端到端而非直连实例 |

#### B. 真实上游请求（硬门槛）

| # | 条件 | 判定 |
|---|---|---|
| B1 | 请求确实到达 SearXNG 并由它转发到至少一个上游引擎 | 实例日志 / `results[].engines` 中出现真实引擎名，而非 Mock 或本地 fixture |
| B2 | `results[].engine` / `engines` 与 `unresponsive_engines` 同时被记录 | 能区分"上游返回"与"上游失败" |
| B3 | 上游故障被如实上报：制造一个不可达引擎，响应中 `unresponsive_engines` 非空，平台状态为 `partial` 或带 `errors`，**不能静默变成成功空数组** | 故障报告 |
| B4 | `time_range=month` 有值时，请求参数确实带上；结果 `publishedAt` 落在近 30 天的比例如实记录，实例不支持时写"未验证时间过滤" | 时间范围，不作为硬门槛 |

#### C. 缓存行为（观察项，**不作为是否可用的判定**）

| # | 观察 | 说明 |
|---|---|---|
| C1 | 同一 query 连续调用，记录结果是否一致、耗时差异、`Cache-Control` / `X-Cache` 头 | SearXNG 与平台都可能缓存 |
| C2 | 结果相同或不同**都是合法行为**：相同说明命中缓存，不同说明上游刷新 | **已删除"三次结果必须不同"的硬性要求**——缓存是正常的、被设计支持的，不能因为命中缓存就判定接口不可用 |
| C3 | 用 `skipCache` / 不同 query 观察缓存路径与非缓存路径 | 只记录，不据此判定通过/失败 |

#### D. 覆盖广度（**观察指标，不是接口可用性门槛**）

| # | 指标 | 用法 |
|---|---|---|
| D1 | 不同结果域名数（例如 ≥5） | 用来衡量"索引覆盖多广"。**域名少不等于接口不可用**：可能是 query 窄、某个引擎占比高、或实例只启用了一个引擎 |
| D2 | 参与引擎数、各引擎返回条数 | 同上，写进报告即可 |

> 一句话：**A + B 决定是否通过；C + D 只写进报告，不单独作为通过/失败依据。** 域名数量不是接口可用性的判断依据。

### 4.5 冒充禁令（本轮明确写死）

- ❌ 用 Hacker News 结果代表通用网页搜索（它是技术社区垂直索引）。
- ❌ 用 `mock` provider 结果代表任何真实覆盖。
- ❌ 用"适配器契约测试通过"代表"实例联调通过"。
- ❌ 用公共实例的一次成功代表"通用网页搜索已验证"。

---

## 5. 执行顺序与责任划分

| 阶段 | 谁做 | 依赖 | 产出 |
|---|---|---|---|
| S0 验证"无 Secret 不会假通过" | 已完成 | — | run 43613257891：3 个 provider 全 SKIP，job 失败并报 `No provider secret`（见 §1.4） |
| S1 Tavily/博查 Secret | **你**（GitHub UI） | 一个 Key | Secret 存在 |
| S2 触发 live workflow | 我（gh CLI） | S1 | run URL + 真实 URL |
| S3 结论回填 | 我（新分支 + PR） | S2 绿色 | `live_tested` + 证据链接 |
| S4 SearXNG 实例 | **你**（机器/实例） | 能出网的 Linux | 实例地址 |
| S5 SearXNG 联调 | 我（同一流程 + 平台端到端） | S4 | 8 条验收结果 |
| S6 44475 协议识别 | **你授权** + 我执行阶段 1 元数据探测 | 明确授权 + 可达主机 | §3.2 阶段 1 表格填写；阶段 2 需另行单独授权 |
| S7 44475 适配 | 我（新分支 + PR） | S6 | 按判定矩阵决定是否需改代码 |

### 现在可以立刻做的（不需要任何新凭证）

1. 用 `provider-live.mjs` 的**失败路径**做一次自检：确认无 Key 时退出码是 2 而不是 0（已由 CI 之外的本地运行覆盖，可复跑一次留证）。
2. 把本文作为 `docs/real-search-validation-plan.md` 提交（当前分支 `docs/real-search-validation-plan`），走 PR 但不合并——需要你批准。
3. 在 `docs/provider-matrix.md` 补一列"最小验证路径"，指向本文的对应小节。

### 需要你提供凭证/授权的

| 项 | 具体需要 | 我不能做什么 |
|---|---|---|
| Tavily | `TAVILY_API_KEY` 写入 `provider-live` Environment | 不能代你创建 Key、不能读取 Secret 值 |
| 博查 | `BOCHA_API_KEY`（需余额） | 同上 |
| Brave | `BRAVE_API_KEY` + Runner 可达 | 同上 |
| SearXNG | 一个启用 JSON 的实例地址（或一台机器） | 不能替你开公网端口 |
| 44475 | **明确授权**阶段 1（元数据）/ 阶段 2（业务探测，含额度消耗）分别授权 + 可达主机 | 未经授权不连接、不探测、不修改、不重启生产服务 |

---

## 6. 状态诚实性约定

本轮任何改动都必须满足：

0. **L1（Adapter 真实联调）不得推论出 L2/L3（REST/MCP 全链路）**，见 §2.5。

1. **没有 run URL 的 `live_tested` 一律不改**。
2. 中文/英文只通过一半，就写"部分通过"并注明哪一半没通过。
3. 实例是公共 SearXNG，只能写"冒烟通过"，不能写"通用网页搜索已验证"。
4. 44475 的结论只能来自 3.2 的实际探测输出，不能来自"应该支持"。
5. AC 矩阵只按真实证据变化；不加测试数量来"提高完成度"。

---

## 7. 当前 AC 状态（基线 4dddd19，未变化）

| 状态 | 数量 | 项目 |
|---|---|---|
| PASS | 11 | AC-03/04/06/07/08/09/10/11/12/14/15 |
| PARTIAL | 4 | AC-01（缺"未就绪"徽标）、AC-02（无通用源真实凭证）、AC-05（客户端 wall 超带）、AC-16（无模型厂商 Key） |
| BLOCKED | 1 | AC-13（无桌面 Agent 客户端） |

**本文不改变任何 AC 状态。** 它只是把"怎么才能改变"写清楚。
