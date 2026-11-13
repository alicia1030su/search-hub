# 验收报告 — Search Hub v0.1.1 → v0.1.2

日期：2026-11-13 ｜ 范围：v0.1.1 生产可用性补强与真实环境验收 ｜ 仓库：`search-hub`（本地仓库路径已移除，发布前不应携带个人路径）

## 0. v0.1.2 增量（本轮）

- **验收矩阵**：[`docs/ac-matrix.md`](./ac-matrix.md)（由 `docs/ac-matrix.json` 生成，固定 16 项）
  — **PASS 10 / PARTIAL 5 / BLOCKED 1**（PARTIAL：AC-01 容器、AC-02 Brave/SearXNG 真实自检、AC-05 端到端耗时带宽、AC-09 容器重启、AC-16 真实厂商；BLOCKED：AC-13 Agent 客户端）。
- **代理出网（P0-1）**：新增显式代理配置与信任边界；真实代理模式联调通过（HN 查询 6 条真实结果，`mode=proxy`）；本地 mock 代理断言被拒目标**从未到达代理**；修复 IPv4-mapped IPv6（`::ffff:7f00:1`）SSRF 绕过。
- **SQLite 备份（P0-2）**：改为 Online Backup API + `integrity_check` + 原子发布；并发写入下 57/57 检查通过；新版 schema 启动拒绝生效。
- **Provider（P1-1）**：Tavily、博查 Bocha 按官方文档实现并加契约测试，保持 `documented`；Brave/SearXNG 仍无真实凭证/实例。
- **模型链路（P1-3）**：Base URL 走同一 SafeFetch、Key 不落响应/导出/备份、维度校验、Rerank 映射、引用过滤、失败降级全部通过；真实厂商联调仍 BLOCKED。
- **质量验证（P1-2）**：`tests/scripts/search-quality.mjs` 可重复运行，结果写入 [`docs/search-quality-report.md`](./search-quality-report.md) + 同名 JSON；当前只有 HN 一个真实源（8/8 请求成功），en-tech 原始 13→去重 12→返回 10，中文时事与 freshness=week 均为 0 条（HN 垂直索引的预期结果），原始重复率 7.7%、返回行内重复率 0%。报告只给数字、不做 provider 排名，并写明「条数不是质量分」。
- **Docker（P0-3）**：仍 **BLOCKED**（Engine 无法启动，WSL 被宿主安全策略禁止）；新增 `scripts/docker-verify.sh` 与 `.github/workflows/docker.yml`，10 项验收可在 Linux/CI 一键复现，本机未执行。
- **测试总数**：Vitest **363** 项（25 文件）、Playwright **5** 项；`typecheck` 与 `lint` 均 0 错误。新增脚本：`backup-restore.mjs`、`search-quality.mjs`、`ac05-concurrency.mjs`、`provider-live.mjs`、`docker-verify.sh`、`ac-matrix.mjs`、`secret-scan.mjs`。
- **本轮修复的真实缺陷 10 项**：`::ffff:` 十六进制映射 SSRF 绕过；`blocked` 被误报为 `auth_invalid`；模型 Key 被上游回显后进入数据库与备份；模型 Base URL 只在调用时校验；降级阶段耗时写到 `stats` 而非 `stats.timing`；`/api/health` 泄露代理地址；Key 掩码只有末 4 位；`clean-install.mjs` 未声明变量导致重启段被静默跳过；Dockerfile `chown -R` 使镜像接近翻倍；`prod-deps` 把 dev 依赖带进运行时。
- **本地提交**：`0182ab2`（未 push、未打 tag、未创建 Release、未改写历史）。

## 1. 一句话结论

v0.1.1 在**无 Docker 的本机环境**完成了真实网络搜索链路、干净生产安装、重启持久化与备份恢复；Hacker News（官方 Algolia API）是唯一完成真实联调的搜索源。**Docker 镜像构建与容器级验收为 BLOCKED**：本机 Docker Engine 无法启动（WSL 被宿主安全策略拦截），已提供复现命令与错误输出。

## 2. 状态总表

| 项目 | 状态 | 证据 |
|---|---|---|
| 首次初始化防抢占（一次性 token + 事务） | **PASS** | `security-hardening.test.ts`（并发 setup 仅 1 行管理员）、干净安装 403/200/文件删除 |
| MCP Host / Origin 校验（鉴权前） | **PASS** | `mcp-client.test.ts`（raw HTTP Host 伪造 → 403；evil Origin → 403；仅 cookie → 401） |
| 反向代理信任边界 | **PASS** | `security-hardening.test.ts`（`X-Forwarded-For` 在未信任时被忽略，在 CIDR 信任时生效） |
| 真实搜索（HN Algolia） | **PASS** | REST/MCP 各返回真实 URL；`live-search.mjs` 20/20；干净安装 6 条结果 |
| 多查询结果不同 | **PASS** | 两个不同 query 重叠 0 条（`live-search.mjs`） |
| 失败/限流不被当成空结果 | **PASS** | 全源失败 → 503 + `failedSources`；单源失败 → 200 + `partial` |
| REST 与 MCP 同一核心 | **PASS** | 8/8 URL 一致、provider 归因一致（`mcp-live.mjs`、`live-search.mjs`） |
| MCP stdio 干净环境可运行 | **PASS** | 官方 client 驱动 `packages/mcp/dist/stdio.mjs`，无 tsx/TypeScript 依赖；关闭 REST 后调用返回错误（代理证据） |
| 生产构建不依赖 tsx | **PASS** | `clean-install.mjs`：install → build → `--prod`（vite/tsx 被裁剪）→ `node apps/api/dist/server.mjs` |
| 三重额度（并发/RPM/日配额） | **PASS** | `key-limits.test.ts`：峰值恰为 2、第 11 次被 RPM 拒、日配额 3 后拒绝 |
| 故障隔离矩阵（超时/401/429/5xx/畸形） | **PASS** | `fault-matrix.test.ts`：每类 50 次，成功率 ≥99%，`failedSources` 精确 |
| 密钥三重泄漏扫描 | **PASS** | `leak-scan.mjs` 18/18：响应/DB（明文+Base64+Hex）/日志命中 0 |
| 重启后配置与统计一致 | **PASS** | `clean-install.mjs`：providers 相同、`searches` 1→1；独立实例 100% 一致 |
| 备份与恢复 | **PASS** | `GET /api/admin/backup` → 新目录 + `master.key` → 登录成功、配置完整、可继续搜索 |
| 可选模型降级 | **PASS** | `model-degradation.test.ts`：rerank/embedding/summary 各自 `degraded=true`，基础结果保留 |
| 缓存默认关闭且可绕过 | **PASS** | `search-errors.test.ts`；实验室强制 `skipCache` |
| 旧版迁移（不泄密、不覆盖） | **PASS** | `legacy-migration.test.ts` 4 项 |
| Web E2E | **PASS** | Playwright 5/5（含 setup token 与目录未实现标注） |
| **Docker 镜像构建 / compose 启动 / 容器重启** | **BLOCKED** | 见 §6 |
| Brave / SearXNG / Tavily / 博查 / 秘塔 真实联调 | **BLOCKED / NOT IMPLEMENTED** | 无凭证/实例；部分主机不可达 |
| PostgreSQL / Redis 多实例 / 向量库 | **NOT IMPLEMENTED** | 文档与 UI 均标注未实现 |
| MCP SSE 流式 | **NOT IMPLEMENTED** | `responseMode: "json"` |

## 3. 本轮修复的真实缺陷

以下每一条都是**代码缺陷**，不是文档措辞问题。

| # | 缺陷 | 影响 | 修复 | 证据 |
|---|---|---|---|---|
| 1 | 受控 DNS `lookup` 只回单个地址，而 Node 22 的 `autoSelectFamily` 以 `all:true` 调用 | **所有真实出站请求失败**（`ERR_INVALID_IP_ADDRESS`）：Brave/SearXNG/HN/模型全不可用，仅 Mock 能跑 | `lookup` 同时支持数组与单值回调 | `tests/unit/safe-fetch.test.ts` 6 项；修复前 `example.com` 亦失败 |
| 2 | 未初始化实例可被任何访问者抢占管理员 | 暴露端口即被接管 | 自动生成一次性 token（0600）、打印到日志、初始化后删除；`BEGIN IMMEDIATE` 内二次校验 | 干净安装 403 → 200；并发测试 200/409 |
| 3 | MCP 只校验 Origin，Host 比对是自指的 | DNS rebinding 可绕过 | Host/Origin 在鉴权前校验，支持 `SEARCH_HUB_ALLOWED_HOSTS` | raw HTTP `Host: rebind.example.com` → 403 |
| 4 | `TRUST_PROXY=true` 信任所有对端 | `X-Forwarded-For` 可伪造，绕过登录限流与审计归属 | 仅信任回环，其他网段需显式 CIDR | 两条对照测试 |
| 5 | 单源超时被归类为 `unknown` | 监控与重试策略误判 | 以 `timeoutController.signal.aborted` 判定 | 现场复现 `unknown` → 修复后 `timeout` |
| 6 | 熔断打开被报成 `server_error` | 与真实 5xx 混淆 | 新增 `circuit_open` 码 | `fault-matrix.test.ts` |
| 7 | MCP 工具结果缺 `provider/providerName/source` | 客户端无法做来源归因 | `toToolResult` 补齐 | `mcp-live.mjs` 归因断言 |
| 8 | UI 令牌默认不含 `sources:read` | `get_search_sources` 返回 403 | 默认勾选并加入可选项 | 官方客户端 20/20 |
| 9 | Dockerfile 从**构建上下文**取 `apps/web/dist` | 干净 `docker build` 必然失败 | 改为从 build stage 复制 | 代码审查（镜像构建本身为 BLOCKED） |
| 10 | `pnpm install --prod` 后再 `pnpm build` 不可行 | 部署文档给出的顺序无法执行 | 改为 install → build → prod install → 运行 bundle | `clean-install.mjs` 28/28 |
| 11 | 备份指引只拷 `.db` | WAL 中 383 KB 数据丢失（实测） | 文档改为 db+wal+shm，新增 checkpoint 与备份接口 | 恢复演练 |
| 12 | stdio 需要 `tsx` 与源码 | 干净生产环境跑不起来 | esbuild 产出 `stdio.mjs` | 官方客户端直接 spawn |

## 4. 真实联调证据

### 4.1 Hacker News（官方 Algolia API）

```text
POST /api/search {"query":"vector database benchmark","mode":"rrf","limit":8}
HTTP 200, 1.46s
status completed, results 8, raw 11, failedSources []
first: Vector Database benchmark with 1536/768 dim data | https://github.com/zilliztech/VectorDBBench | hn-live
```

`live-search.mjs`（真实实例，真实网络）：

```text
PASS: REST "typescript monorepo": HTTP 200 — status=completed
PASS: REST "typescript monorepo": has results — 8 results
PASS: REST "typescript monorepo": every result has an absolute URL — 8 unique URLs
PASS: REST "rust async runtime": has results — 8 results
PASS: different queries return different result sets — 0 overlapping of 8/8
PASS: each live call gets a new task id
PASS: MCP returns results from the same core — 8 results
PASS: MCP and REST agree on the result set — 8/8 overlapping URLs
PASS: invalid token is rejected — HTTP 401
20/20 checks passed
```

### 4.2 MCP 官方客户端（HTTP + stdio）

```text
PASS: http: tools/list returns >= 9 tools — 9 tools
PASS: http: search_web returns structured results — 5 results
PASS: http: result carries provider attribution
PASS: stdio: search_web returns structured results — 5 results
PASS: parity: HTTP and stdio return the same search core output — 5/5 overlapping URLs
20/20 checks passed
```

关闭 REST 后（`SEARCH_HUB_URL=http://127.0.0.1:9`）stdio 调用的实际返回：

```text
tools 9
call returned isError= true text= {"error":{"message":"fetch failed"}}
```

这证明 stdio 是 REST 代理，而不是第二套实现。

### 4.3 未被当作真实联调的项

- **Mock 源**：所有 E2E/冒烟脚本中的 Mock 结果均为 `example.com` 合成 URL，属**契约测试**，不计入真实搜索证据。
- **Brave / SearXNG / Tavily / 博查 / 秘塔 / 大模型厂商**：无凭证或主机不可达，见 §6。

## 5. 干净生产安装 + 重启 + 恢复（无 Docker）

`node tests/scripts/clean-install.mjs`：

```text
PASS: copy: workspace created without node_modules/.data — 25 entries
PASS: install (full) (exit 0) — 7281ms
PASS: build (exit 0) — 8111ms
PASS: build: server bundle + migrations exist
PASS: build: stdio bundle exists
PASS: install (prod only) (exit 0) — 476ms
PASS: prod install: tsx pruned
PASS: prod install: vite pruned
PASS: boot: health 200
PASS: boot: migrations applied — 1
PASS: setup: token generated
PASS: setup: anonymous attempt rejected — HTTP 403
PASS: setup: administrator created — HTTP 200
PASS: setup: token file removed
PASS: provider: live HN source created — HTTP 200
PASS: provider: self-test hit the real API — Provider responded with 3 result(s) in 1685ms
PASS: search: live results — 6 results
PASS: search: real absolute URLs
PASS: restart: providers identical — hn-live:hackernews:true
PASS: restart: counters preserved (not reset) — 1 -> 1
PASS: backup: snapshot downloaded — 180224 bytes
PASS: backup: snapshot does not contain plaintext key
PASS: restore: boots from the downloaded snapshot
PASS: restore: administrator can sign in — HTTP 200
PASS: restore: provider configuration intact — hn-live
PASS: restore: live search still works — 3 results
28/28 checks passed
```

独立实例（`.data/smoke3`，端口 8821）的冒烟结果：

```text
=== 1. health ===
=== 2. first-run setup (requires the one-time token) ===
...
=== 10. MCP initialize over Streamable HTTP ===
SMOKE TEST PASSED
MCP server: search-hub protocol: 2025-11-25
```

## 6. BLOCKED：Docker

### 6.1 诊断

```text
$ docker version
Client: 29.9.2 (Windows amd64, context desktop-linux)
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running:
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.

$ docker info
Server: <empty>
...
$ docker build -t search-hub:v0.1.1 .
ERROR: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
exit code 1

$ docker compose config --quiet
exit code 0        # 文件语法有效
```

根因链：

```text
com.docker.service → Stopped (StartType Manual)
Start-Service → 拒绝访问（当前进程非管理员）
Docker Desktop.exe → 已启动，但 backend.lock/frontend.lock 未出现
wsl --status → PROGRAM BLOCKED BY SECURITY POLICY: wsl.exe
（sandbox 禁止启动 WSL，无法批准或绕过）
```

因此容器构建、`docker compose up`、容器停止/重启、`docker stats` 资源测量**均无法执行**，标记 **BLOCKED**，不宣称成功。

### 6.2 已完成的替代验证

| Docker 验收项 | 替代证据 | 结论 |
|---|---|---|
| 干净环境构建镜像 | 干净目录 install → build → prod-only → 运行 bundle | 等价 PASS |
| Compose 启动 | `docker compose config --quiet` 通过；compose 语法/卷/健康检查静态校验 | 部分 PASS |
| 首次初始化 | 干净安装脚本 | PASS |
| 数据库持久化 | 同进程重启 + 独立目录重启对比 | PASS |
| 密钥加密恢复 | 备份含密文、恢复后可解密并真实调用 | PASS |
| 统计持久化 | `searches` 1→1 | PASS |
| 备份恢复 | `GET /api/admin/backup` → 恢复并搜索 | PASS |
| 资源占用 | 原生进程：空载 **81.8 MB** RSS / 257 句柄；50 次搜索后 **86.4 MB** / 254 句柄 / CPU 1.7s | PASS（非容器） |

## 7. 资源占用实测

| 场景 | RSS | Private | 线程 | 句柄 |
|---|---|---|---|---|
| 启动后空载（`node apps/api/dist/server.mjs`） | 81.8 MB | 81.6 MB | 16 | 257 |
| 50 次 RRF 搜索后 | 86.4 MB | 85.3 MB | — | 254 |

说明：这是 **Windows + Node 22.22.2 原生进程**数据，不是容器数据；容器 `docker stats` 因 §6 无法获取。2C2G 主机在此量级有充足余量，但**未做容器内压测**。

## 8. 文档与实际代码的对账（本轮修正）

| 文件 | 原问题 | 现状 |
|---|---|---|
| `docs/architecture.md` | 保留 E-1…E-6 / D-1…D-6 待裁决项，称"全源失败返回 200"、"无排队"、"4 个适配器" | 重写为 F-1…F-10 事实表；503、有界队列 1024、5 个适配器、init/Host/代理边界均已更新；历史裁决表标注"已关闭" |
| `docs/product-mvp.md` | `/v1/search`、`failed_sources`、`QUEUE_TIMEOUT`、缓存"本期不做" | 改为 `/api/search`、`failedSources`、`queue_timeout`；缓存改为"实现但默认关闭、实验室强制绕过" |
| `docs/api.md` | CSRF 描述覆盖 Bearer 请求；503 错误码不全；缺新接口 | 明确 CSRF 仅 Cookie 请求；补 `queue_timeout`/`circuit_open`；补 backup/migration/cache/degraded |
| `docs/deployment.md` | `install --prod` 后 `build` 并用 `tsx` 启动；备份只拷 `.db` | 改为 install → build → prod → bundle；补 WAL 三文件与备份接口；补 setup token、Host 白名单、代理 CIDR |
| `docs/mcp.md` | `npx tsx src/stdio.ts`；称"handler 不做 Host 校验" | 改为 `node dist/stdio.mjs`；补 Host 前置校验与 Bearer-only |
| `README.md` / `README_EN.md` | 仓库 URL 指向未创建的 `search-hub/search-hub`；`4 类`/`26 条`/`139 项`/`0.1.0` | 改为 `<your-org>` 占位；5 类 / 27 条 / 177 项 / 0.1.1；补 setup token 步骤与 Docker BLOCKED 说明 |
| `docs/testing.md` | 139 项清单，未含本轮测试 | 177 项、17 文件，新增脚本表与 BLOCKED 清单 |
| `docs/architecture-decisions.md` | D-5 队列上限 512、E-1 目录 26/4 | 1024、27/5；新增 E-3/E-4/E-5 |
| `CHANGELOG.md` | 无 0.1.1 | 完整 0.1.1（Fixed/Added/Changed/Limitations） |
| `docs/legacy-migration.md` | 不存在 | 新增迁移机制说明 |

## 9. 下一轮 Provider 优先级

按"官方接口可验证性 + 无/低成本凭证 + 与现有架构契合度"排序。

| 优先级 | Provider | 官方接口 | 鉴权 | 建议 |
|---|---|---|---|---|
| P0（已完成） | Hacker News | `https://hn.algolia.com/api/v1/search` | 无 | 已联调，作为零凭据基线 |
| P1 | Brave | `GET /res/v1/web/search`，`X-Subscription-Token` | 订阅 Key（有免费档） | 适配器已按文档实现；缺 Key 与网络。**本机到该主机超时，需换网络环境验证** |
| P1 | SearXNG | 自建 `/search?format=json` | 无 | 适配器已实现；需真实实例（本机公共实例不可达） |
| P2 | Tavily | `POST https://api.tavily.com/search` | `api_key`（有免费额度） | 官方端点可达（401 证明在线），结构简单，适合作为第二个真实联调源 |
| P2 | 博查 Bocha | `POST https://api.bochaai.com/v1/web-search` | `Bearer` | 端点可达（405 on GET），中文网页覆盖好；需申请 Key 后按官方文档实现 |
| P2 | 秘塔 MetaSo | `POST https://metaso.cn/api/v1/search` | `Authorization` | 端点可达（405 on GET）；需确认官方开放平台条款 |
| P3 | 智谱 Web Search | `POST https://open.bigmodel.cn/api/paas/v4/web_search` | `Bearer` | 端点可达（401），属 AI 搜索层，需单独适配 |
| P4 | Gemini / Grok / 其他模型联网 | 各家 grounding 接口 | Key | 返回结构与网页搜索不同，需 AI 搜索适配层 |

接入判据（与 CONTRIBUTING 一致）：有官方文档链接、错误码映射、Mock 测试、**一次真实调用记录**，四者齐备才可从 `planned` 升为 `builtin`。

## 10. 旧 Search Hub 迁移

机制与安全属性见 [legacy-migration.md](./legacy-migration.md)。要点：

- `POST /api/admin/migration/legacy`，默认 `dry_run`；`apply` 需 `"confirm":"IMPORT LEGACY PROVIDERS"`。
- 旧兼容网关（Search Gateway / Alt / Premium / ORZ / Union Free / Zhihu Radar / GPT55）→ `generic-http` 声明式映射；同名源一律跳过。
- **不读取、不传输、不落盘任何凭据**：payload 中的 `apiKey`/`key`/`token` 被忽略；导入后 `api_keys` 表为 0 行；Key 需在新 UI 重新录入。
- 不连接旧服务器，不修改旧配置。

## 11. 发布前仍需人工确认

| 项 | 状态 |
|---|---|
| `docker build` 与 `docker compose up` | 需在可用 Docker 环境执行（CI `build` job 已写好，未在本地跑通） |
| Brave / SearXNG 真实联调 | 需 Key / 实例 |
| 大模型、Embedding、Rerank 真实厂商联调 | 需 Key；当前仅本地模拟服务验证契约 |
| 仓库地址与组织名 | README 使用 `<your-org>` 占位，发布时替换 |
| Push / Tag / Release | **未执行**，按要求等待维护者授权 |

## 12. Git 状态

见本轮最终提交（`git log --oneline -1` 与 `git status`）。未 push、未打 tag、未创建 Release、未改写历史。

## 13. 提交后的复验（最终证据）

提交：`089ae46 fix: v0.1.1 production hardening and real-environment acceptance`

在**全新数据目录**（`.data/final-v011`，端口 8830，编译产物 `apps/api/dist/server.mjs`）上依次执行：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 冒烟（含 setup token、双源、Key、故障隔离、Token、MCP initialize） | `SEARCH_HUB_DATA_DIR=./.data/final-v011 bash tests/scripts/smoke.sh http://127.0.0.1:8830` | **SMOKE TEST PASSED** |
| 真实搜索（HN，两个 query，REST/MCP 一致性） | `node tests/scripts/live-search.mjs --url http://127.0.0.1:8830 --token sh_...` | **20/20 checks passed** |
| MCP 官方客户端（HTTP + stdio） | `node tests/scripts/mcp-live.mjs --url http://127.0.0.1:8830 --token sh_...` | **20/20 checks passed** |

真实结果示例（同一实例）：

```text
PASS: different queries return different result sets — 0 overlapping of 8/8
PASS: each live call gets a new task id — task_... vs task_...
PASS: MCP and REST agree on the result set — 8/8 overlapping URLs
PASS: MCP carries provider attribution — prv_... vs prv_...
```

注意：冒烟脚本创建的 Mock 源会产生 `example.com` 合成结果。为得到纯真实证据，复验时先停用了 Mock 源，只保留 `hn-live`。

## 14. 本轮未做（明确边界）

- 未实现 MCP SSE 流式、PostgreSQL、Redis 多实例、向量库、多租户。
- 未实现旧版迁移的 Web UI；该能力仅提供 REST 接口与 curl 流程（见 `docs/legacy-migration.md`）。
- 未执行 `git push`、打 Tag、创建 Release、改写历史。

## 15. AC-01 ~ AC-16 逐项判定

**唯一验收矩阵见 [docs/ac-matrix.md](./ac-matrix.md)**，由 `docs/ac-matrix.json` 经 `node scripts/ac-matrix.mjs` 生成。

- 固定 16 项（AC-05b 并入 AC-05 的子项），每项只有一个总体状态；
- PASS 必须有可复现 evidence，PARTIAL/BLOCKED 必须写缺口，脚本会拒绝不合规的条目；
- 统计数字只保留 §0 一处（PASS 10 / PARTIAL 5 / BLOCKED 1），且由 `tests/unit/ac-matrix.test.ts` 断言与 `docs/ac-matrix.json` 完全一致；一旦矩阵变动而报告未同步，测试会失败。

