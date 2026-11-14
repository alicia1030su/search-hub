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
| SearXNG 通用网页联调 | **是**（二选一：自建实例 / 本地容器） | 一个启用了 JSON 的实例 | 真实中英文结果 + 来源域名多样 |
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

> 一个真实局限：`freshness` 只对中文 query 生效，英文 query 不带时间过滤。这是有意为之（避免旧结果被误判为失败），但也意味着**时间范围过滤只在一半样本上被验证**。

---

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

### 3.2 最小协议识别方案（按顺序，全部只读）

原则：**先读不写、先 GET 后 POST、不触发任何写操作、不改旧库**。每条都要留证据（状态码 + 响应体片段 + 时间），失败也要记录。

| 步骤 | 动作 | 目的 | 判定 |
|---|---|---|---|
| R0 | 在**授权主机**上 `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://<host>:44475/api/health` | 服务是否活着、是否为本项目 | 200 + `{"status":"ok"}` → 同源 |
| R1 | `curl -sS -m 5 http://<host>:44475/api/openapi.json` | 拉 OpenAPI，一次拿到全部路径与字段 | 有 `paths["/api/search"]` → REST 存在 |
| R2 | `curl -sS -m 5 http://<host>:44475/api/search -X POST -H 'content-type: application/json' -d '{"query":"test","limit":1}'` | 最小只读搜索 | 200 → REST 可用；401/403 → 需鉴权；404 → 路径不同 |
| R3 | 若 R1 无 `/api/search`：`curl -sS -m 5 'http://<host>:44475/search?q=test&format=json'` | 探测旧版是否用 `/search` | 200 JSON → 用 `path: "/search"` |
| M1 | `curl -sS -m 5 -D - -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' http://<host>:44475/mcp` | MCP 是否存在 | SSE `data:` 含 `serverInfo` → MCP 可用 |
| A1 | 若 R2 返回 401：用一个**低权限只读 token** 重试（无 token 则跳过） | 确认鉴权方式 | 401 说得清 Bearer / cookie |
| A2 | 检查 `WWW-Authenticate` 头 | 鉴权方案 | `Bearer` / `Cookie` |
| E1 | 记录 R2 成功响应的**顶层键名** | 信封形状 | `results` / `data` / `items` |
| E2 | 记录单条结果的字段名 | 来源归因 | 是否有 `provider`/`source`/`sources`/`siteName` |
| E3 | 构造错误：`{"query":""}` 或 `{"limit":0}` | 错误码形状 | 400 + 错误体结构 |

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

- 不连接、不探测、不重启 44475。
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

### 4.4 验收条件（严格定义"通用网页搜索已验证"）

| # | 条件 | 判定 |
|---|---|---|
| 1 | 实例 `/search?q=test&format=json` 返回 200 JSON | 基础可用 |
| 2 | 中文 query（`中国 新能源汽车 产业 最新政策`）≥5 条真实 `https` 结果 | 中文覆盖 |
| 3 | 英文 query（`typescript monorepo best practices`）≥5 条 | 英文覆盖 |
| 4 | 结果 `source` 域名 ≥5 个不同域名 | **不是单站结果**，这才是"通用网页"而非垂直索引 |
| 5 | `time_range=month` 生效：结果 `publishedAt` 落在近 30 天比例 ≥50%，或实例不支持时明确记录"未验证时间过滤" | 时间范围 |
| 6 | 同一 query 连跑 3 次，结果集非完全相同 | 证明是实时检索而非缓存 |
| 7 | 通过平台 `POST /api/search`（`providers: [searxng]`）拿到同样结果 | 端到端而非直连实例 |

**不满足第 4 条就不能写"通用网页搜索已验证"**——那只是"某个引擎的某个索引可用"。

### 4.5 冒充禁令（本轮明确写死）

- ❌ 用 Hacker News 结果代表通用网页搜索（它是技术社区垂直索引）。
- ❌ 用 `mock` provider 结果代表任何真实覆盖。
- ❌ 用"适配器契约测试通过"代表"实例联调通过"。
- ❌ 用公共实例的一次成功代表"通用网页搜索已验证"。

---

## 5. 执行顺序与责任划分

| 阶段 | 谁做 | 依赖 | 产出 |
|---|---|---|---|
| S1 Tavily/博查 Secret | **你**（GitHub UI） | 一个 Key | Secret 存在 |
| S2 触发 live workflow | 我（gh CLI） | S1 | run URL + 真实 URL |
| S3 结论回填 | 我（新分支 + PR） | S2 绿色 | `live_tested` + 证据链接 |
| S4 SearXNG 实例 | **你**（机器/实例） | 能出网的 Linux | 实例地址 |
| S5 SearXNG 联调 | 我（同一流程 + 平台端到端） | S4 | 8 条验收结果 |
| S6 44475 协议识别 | **你授权** + 我执行只读命令 | 明确授权 + 可达主机 | 3.2 表格全部填写 |
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
| 44475 | **明确授权只读探测** + 可达主机 | 未经授权不连接、不重启、不改配置 |

---

## 6. 状态诚实性约定

本轮任何改动都必须满足：

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
