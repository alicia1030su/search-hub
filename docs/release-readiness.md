# 发布就绪报告

## v0.1.12 Stable 候选（2026-11-21）

> **口径**：本节是候选就绪记录，不是发布完成报告。Vitest 总数、Playwright 结果、远端 CI、
> 三平台实机验收、升级矩阵与正式 Release 均须由发布负责人在最终提交上核验；未观察到结果
> 的项目明确写为待验证，不沿用 v0.1.11 的通过记录。

| 项 | 候选状态 |
|---|---|
| 目标版本 | **v0.1.12（Stable 候选）**，前序 Stable 为 v0.1.11 |
| 自动化测试 | **PASS（本地）**：1241 项 / 96 文件，`vitest run --maxWorkers=2` exit 0 |
| 浏览器 E2E | **PASS（本地）**：Playwright 42/42，最终构建上实跑确认 |
| 文档 / Provider 矩阵门禁 | **PASS（本地）**：`pnpm check:docs` / `pnpm check:matrix` 均 exit 0 |
| 类型检查 | **PASS（本地）**：`pnpm typecheck` exit 0（服务端 + Web） |
| 迁移 | 0001–0011；0010 归档并保守重算 `connect` 物理跳账本；0011 增加诊断 sanitized 标记，旧行默认 false、原文不改，读取时 withheld |
| 真实 v0.1.11 → current 升级 | 已在 `upgrade.yml` 配置 Windows/Linux、端口 8929；**远端结果未验证，不得记 PASS** |
| 远端 CI | **PENDING（未验证）**：候选提交的正确 SHA 与全部 required checks 待观察 |
| 三平台发布包 / Docker / systemd | **PENDING（v0.1.12 未验证）**：v0.1.11 的历史通过记录不作为本轮证据 |
| 正式 Release / GHCR / Provenance | **PENDING（未验证）**：未观察到本候选的 tag、Release 或镜像发布证据 |
| 真实厂商联调 | 仍为 Hacker News、Crossref、OpenAlex、PubMed 4 个源；其余未联调 |
| 多实例 | **NOT_IMPLEMENTED**：同源探测锁与 SQLite 预算均为单进程 |

### v0.1.12 候选修复范围

1. 修复 URL query API Key 在 JSON/HTML/编码错误、错误 `details.url`、SQLite 健康历史、
   Key `last_error_message`、审计详情与 MCP 健康输出中的泄漏；非敏感查询参数保留用于排障。
2. 单源、批量、Key 与定时探测统一经过 `HealthService.probeWithLock`；重复探测为
   `409 already_running`，批量条目记 skipped，不重复发请求。
3. 连接探测按物理 HTTP 跳预留预算，默认单次 5 跳 / 每日 50 跳；本地超限为
   `429 quota_exceeded`，不写健康结论、不失效 Key、不停用源；批量记 `SKIPPED_BUDGET`。
4. 探测结果与健康详情明确 `billingUnit:"unknown"`，不把请求数冒充厂商账单。
5. 批量预检、健康概览、设置 GET 与 MCP 健康读取只读；缺失账本只在内存从
   `spent=true` 计费行计算，不物化预算、不写审计。
6. Key 创建/更新最短 8 字符；脱敏的 `lastErrorCode` / `lastErrorMessage` 持久化，
   重测成功后清除。迁移 0011 让旧诊断在 Key 轮换/删除后仍安全 withheld。

### 候选验证记录

| 命令 / 检查 | 执行环境 | 结果 |
|---|---|---|
| `pnpm check:docs` | 本地候选工作树 | **PASS**，exit 0；catalog 58 / builtin 50 / live_tested 4 |
| `pnpm check:matrix` | 本地候选工作树 | **PASS**，exit 0；生成矩阵与 catalog 一致 |
| `pnpm typecheck` | 本地候选工作树 | **PASS**，exit 0；`tsconfig.node.json` 与 Web tsconfig 均通过 |
| `pnpm test` | 本地候选工作树 | **PASS**：1241/96，exit 0 |
| `pnpm test:e2e` | 本地候选构建 | **PASS**：42/42，exit 0 |
| `pnpm build` / typecheck / lint | 本地候选工作树 | **PASS**：构建成功；类型 0 error；lint 0 warning / 0 error |
| `pnpm audit --audit-level high` | 本地候选工作树 | **PASS**：无已知漏洞 |
| `node scripts/secret-scan.mjs` | 本地候选工作树 | **PASS**：434 个文本文件 / 71 refs，0 violation；未修改白名单 |
| launcher / updater / fault injection | 本地 Windows | **PASS**：生命周期、安装回滚、下载/校验/架构/迁移回滚故障注入全部通过 |
| Upgrade / Docker / systemd / Release | GitHub Actions | **PENDING（未验证）** |

### 已知限制与发布阻断口径

- 探测锁、Key 额度与预算仍不跨进程；多实例部署没有协调者。
- 连接 HTTP 跳数是本地安全预算，不是厂商计费单位；`billingUnit` 保持 `unknown`。
- 只有 4 个搜索源有真实网络证据，质量评测仍只有合成基准。
- **在此节所有“待验证”项得到正确 SHA 的真实结果之前，不得把 v0.1.12 标记为已发布或
  全部门禁 PASS。** 本地文档检查通过也不能替代测试、打包实机验收与资产校验。

---

## v0.1.11 Stable（2026-11-21）

| 项 | 结果 |
|---|---|
| 目标版本 | **v0.1.11（Stable）**，前序为 v0.1.10 |
| 自动化测试 | **1152 passed / 88 files**（`pnpm test`，冻结候选构建） |
| 浏览器 E2E | **42 passed**（`pnpm test:e2e`） |
| 类型 / Lint | `pnpm typecheck` 0 error；`oxlint` 0 warning / 0 error |
| 构建 | `pnpm build` PASS；Windows x64 / Linux x64 候选包已在 CI 真实构建、启动并通过 REST/MCP 与重启持久化验收 |
| 质量门禁 | `pnpm quality:eval` PASS（11 项手算自检全过；合成数据不足以支持优胜声明） |
| 依赖审计 | `pnpm audit --audit-level high` 无已知漏洞 |
| 密钥扫描 | 正确工作树 423 个文本文件 + 68 个 ref，0 violation；未扩大白名单、未关闭扫描 |
| 迁移 | 0001–0009；0009 侧表记录 `budget_day`/`spent`，旧搜索保守计入付费桶，旧账本原样归档并一次性重算 |
| 故障注入 | launcher lifecycle、updater install/rollback、updater fault injection 全部 PASS |
| Docker | **PASS（CI）**：24/24、0 skipped；真实 HN 探测 `requests=1`，down/up 后预算 `1→1`、健康记录时间与请求数不变；Trivy CRITICAL=0 / HIGH=0 |
| systemd | **PASS（CI）**：真实 HN 计划探测 `requests=1`；重启、停止 70 秒、升级失败回滚后预算始终 `1→1`，健康记录与 `nextProbeAt` 不变 |
| 三平台正式发布包 | **PASS（tag CI）**：Windows x64 / Linux x64 / Linux arm64 均在对应 runner 构建、启动并通过 REST/MCP 验收；资产与 SHA256SUMS 已发布 |
| 真实 v0.1.10 → current 升级 | **PASS（CI）**：Windows 与 Linux 均下载真实 v0.1.10 发布包，对当前候选包就地升级；管理员、会话、Provider、Key 解密、搜索参数、REST/MCP 均保留 |
| 真实厂商联调 | **4 个源**：Hacker News、Crossref、OpenAlex、PubMed；其余未联调 |
| 多实例 | **NOT_IMPLEMENTED**：单进程额度、SQLite 预算与批量任务协调 |

### v0.1.11 修复范围

1. 单 Key 失败不再一律写成 `invalid`；401、403、429、额度、DNS/TLS/超时/5xx 分类分离。
2. 禁止跨 Provider 使用 Key；多 Key 统一走 `ProviderService`/`KeyScheduler` 可用性过滤与轮换。
3. 免 Key 来源由任务级 `includeKeyless` 控制，与付费探测门禁分离；generic-http 凭据要求按配置识别。
4. 独立匿名预算、`spent=0` 不计费、跨 UTC 午夜按预留日退款、账户组配额不串日。
5. 批量取消在 immediate transaction 内原子更新终态、条目与计数；重启不会把半完成写成完成。
6. 落账/排程/预算预留异常不会二次退款或泄漏 Key 租约；概览不可解密 Key 不再误报健康。
7. Dashboard 完整统计 `forbidden` 与 `quota_exhausted`，Key 分段之和等于总数。

### CI 证据（产品代码门禁提交 `83557f9`）

| 门禁 | Run | 结果 |
|---|---|---|
| CI | [44855896989](https://github.com/alicia1030su/search-hub/actions/runs/44855896989) | **PASS**：88 files / 1152 tests、Playwright 42/42、typecheck、lint、Windows launcher/updater、持久缓存、依赖审计与 Secret Scan |
| Docker | [44855897001](https://github.com/alicia1030su/search-hub/actions/runs/44855897001) | **PASS**：24/24、0 skipped；真实 HN 健康探测与预算持久化、50/50 负载、崩溃恢复、MCP/REST 一致、Trivy 0/0 |
| systemd | [44855897033](https://github.com/alicia1030su/search-hub/actions/runs/44855897033) | **PASS**：真实 HN 计划探测；重启、停止、升级失败回滚后预算与健康状态不变 |
| 升级 / 故障注入 | [44855897006](https://github.com/alicia1030su/search-hub/actions/runs/44855897006) | **PASS**：Windows/Linux 真实 `v0.1.10 → current`，以及 updater 校验和、降级、架构、健康失败回滚 |

Docker 首次候选运行在第 7 项失败，原因是旧脚本要求 mock 探测产生预算消耗；v0.1.11 对零物理请求正确退款。验收脚本已改用真实 HTTP 探测，未放宽预算、漏洞或测试门禁。H49 的固定时间单测也补齐了租约释放时钟，避免跨 UTC 日时依赖 CI 运行日期。

### 发布事实

- annotated tag `v0.1.11` → `178483ee515283c229f6aa352b47d589129da75c`；Release `prerelease=false`、`isDraft=false`，并已由 `/releases/latest` 确认为 GitHub Latest。
- 发布工作流 [44858434072](https://github.com/alicia1030su/search-hub/actions/runs/44858434072) **PASS**：三平台包各自实机启动、REST/MCP 验收；发布后重新下载全部资产并执行 `sha256sum -c`，四份资产逐一通过 `gh attestation verify`。
- 资产 4 个：Windows x64 74,146,603 bytes / Linux x64 49,644,568 bytes / Linux arm64 49,481,962 bytes / SHA256SUMS 307 bytes。`SHA256SUMS` 三条摘要与 GitHub API 返回的资产 digest 逐条一致。
- 四份资产均存在于同一份 SLSA Provenance 的 subject 中；构建器为 `alicia1030su/search-hub/.github/workflows/release.yml@refs/tags/v0.1.11`，invocation 为 run `44858434072`。
- GHCR `0.1.11`、`v0.1.11`、`latest` 三个标签均指向 `sha256:7c765e35e217c4d6008b6b7222159e72fe1422118ef6d2afa442a06b19721315`，registry manifest 平台为 `linux/amd64`。

### 未通过 / 受限

| 项 | 状态 | 说明 |
|---|---|---|
| 本机完整资产下载 | **BLOCKED（宿主网络）** | Release 下载与资产 API 均在大文件传输中超时；未把本地截断文件当作校验依据。发布 CI 已完整下载并做字节级 SHA256 与密码学 Provenance 验证，本机另做 API digest / attestation subject 交叉核验 |
| 真实厂商联调 | **受限** | 仅 4 个源有真实网络证据 |
| 质量评测数据 | **受限** | 只有合成基准，无厂商标注集 |
| 多实例 | **NOT_IMPLEMENTED** | 无跨进程协调者 |

---

## v0.1.10 Stable（2026-11-19）

| 项 | 结果 |
|---|---|
| 目标版本 | **v0.1.10（Stable）**，前序为 v0.1.9；本轮另有 v0.1.10-beta.1 / -beta.2 两次预发布 |
| 自动化测试 | **1034 passed / 78 files**（`pnpm test`，发布提交 `f5cf56a`） |
| 浏览器 E2E | **38 passed**（`pnpm test:e2e`），覆盖单源测试、批量体检、刷新恢复、顶部入口、重复点击幂等、混合五类统计与免 Key 策略 |
| 类型 / Lint | `pnpm typecheck` 0 error；`oxlint` 0 warning / 0 error（281 files） |
| 质量门禁 | `pnpm quality:eval` PASS（11 项手算自检全过） |
| 依赖审计 | `pnpm audit --audit-level high` 无已知漏洞 |
| 密钥扫描 | `scripts/secret-scan.mjs` 在发布工作树（410 个文本文件 + 63 个 ref）0 violation；截图脚本的口令改为运行时生成，**未扩大白名单** |
| 迁移 | 0001–0008，全部为增量；0008 有升级/幂等/旧行兼容测试 |
| 三平台包 | Windows x64 / Linux x64 / Linux arm64 均在 GitHub Actions 对应平台构建，并各自通过「启动 + setup + REST 搜索 + MCP 三步 + 重启后数据仍在」16 项验收 |
| Docker | 容器验收在 GitHub Actions 真实通过（Image, compose stack, MCP and 11-item acceptance）；镜像 `linux/amd64` 单架构 |
| 升级与回滚 | CI：v0.1.4-beta.6 / v0.1.5-beta.1 / v0.1.7-beta.3 / v0.1.8 / v0.1.8-beta.1 → current 全部通过；**本地另做 v0.1.9 → v0.1.10 就地升级 24 项全过**（Key 仍可解密、会话仍有效、搜索与 MCP 正常） |
| systemd | `systemd service lifecycle` 工作流在合并提交上通过 |
| 故障注入 | `updater-faults` + `updater-test`（校验和拒绝、降级拒绝、架构拒绝、健康检查失败回滚）全部 PASS |
| 真实厂商联调 | **4 个源**：Hacker News、Crossref、OpenAlex、PubMed |
| 未联调 | 其余适配器按官方文档实现，无真实凭证 |
| 多实例 | 未实现（单进程额度 + SQLite 预算账本；批量任务同样只支持单进程） |

发布事实：tag `v0.1.10` → `f5cf56a`（annotated），Release `prerelease=false` 且为 GitHub Latest；
资产 4 个（Windows x64 74.1 MB / Linux x64 49.6 MB / Linux arm64 49.5 MB / SHA256SUMS），
三份 digest 与 `SHA256SUMS` 逐条一致；四个资产均有有效的 build provenance（签名者
`release.yml@refs/tags/v0.1.10`，源提交 `f5cf56a`）；GHCR 推送 `0.1.10`、`v0.1.10`、`latest`
三个 tag，digest `sha256:c06b2a7e…`，`platforms=linux/amd64`。

除上表已注明「未联调 / 未实现」的项，本节各门禁均已实际运行并通过；**没有任何一项以
「部分完成」代替结果**，也**没有把未验证项描述为已通过**。受限项集中列在下面的
「未通过 / 受限」中。

### v0.1.10 的验收范围

1. 单源测试与定时巡检走同一条 `HealthService.checkOne` 链路（分页源不再被误判为空结果）。
2. 批量体检的 7 类资格计数、跳过不计入失败率、免 Key 来源默认跳过。
3. 物理上游请求计数来自 fetch 边界，不是按页数推算。
4. 付费预算、并发上限 4、同源去重 `probeWithLock` 不被批量路径绕过。
5. 任务级取消、重启 `interrupted`、运行中可读已完成结果、刷新后可回看。
6. 跨账号隔离：`search` scope 与其它账号都无法读取或取消本账号任务。
7. 结果表 8 列、详情抽屉、脱敏 Key、`—` 代替未测量值。
8. 中英文文案齐全（`i18n-parity` 强制）。

### 未通过 / 受限（逐项，不用「部分完成」概括）

| 项 | 状态 | 说明 |
|---|---|---|
| v0.1.9 → v0.1.10 升级 | **PASS（本地）** | 用 v0.1.9 tag 源码本地打包，对 v0.1.10 包做就地升级，24 项断言全过；CI 的升级矩阵覆盖到 v0.1.8 与各 beta，不含 v0.1.9 这一条，故以本地实测补证 |
| Windows / Linux 安装包 | **PASS（CI 实机）** | 三种目标各自在对应 runner 上构建并启动验收，不是「能编译」 |
| Linux arm64 实机运行 | **PASS（CI）** | `ubuntu-24.04-arm` runner 上构建并启动验收 |
| Docker 镜像 | **PASS（CI）** | 11 项容器验收通过；镜像仅 `linux/amd64`，arm64 主机请用独立包 |
| 真实厂商联调 | **受限** | 仅 4 个源有真实凭证与真实网络证据；其余按官方文档实现，未联调 |
| 质量评测数据 | **受限** | 只有合成基准，没有厂商标注集；分数只衡量机制，不衡量厂商 |
| 多实例批量任务 | **NOT_IMPLEMENTED** | 单进程；跨实例无队列/协调者 |
| 批量任务历史图表 | **NOT_IMPLEMENTED** | 台账保留多次运行，UI 一次展示一次 |
| 刷新恢复的跨浏览器行为 | **受限（已知）** | 指针是浏览器本地 `localStorage`；换浏览器看不到快捷入口，任务本身仍可由 API 读取 |

---

## v0.1.9 Stable（2026-11-18）

本节是当时版本的就绪判断；其后的章节是历史记录（v0.1.2 RC / v0.1.3 增量），保留以便对照，
数字与结论都只对当时的版本成立。

| 项 | 结果 |
|---|---|
| 目标版本 | **v0.1.9（Stable）**，前序为 v0.1.8 |
| 自动化测试 | **876 passed / 60 files**（`corepack pnpm test`） |
| 浏览器 E2E | **19 passed**（`corepack pnpm test:e2e`） |
| 类型 / Lint | 0 error / 0 warning |
| 质量门禁 | `pnpm quality:eval` PASS，11 项手算自检全过 |
| 依赖审计 | `pnpm audit --audit-level high` 通过，1 个已记录的无补丁例外（见 SECURITY.md） |
| 迁移 | 0001–0006，全部为增量；0006 有升级/幂等/级联测试 |
| Docker | 11 项容器验收在 GitHub Actions 真实通过；镜像为 `linux/amd64` 单架构 |
| 三平台包 | Windows x64 / Linux x64 / Linux arm64，各自在对应平台启动验收 |
| 真实厂商联调 | **4 个源**：Hacker News、Crossref、OpenAlex、PubMed |
| 未联调 | 其余适配器按官方文档实现，无真实凭证 |
| 质量评测数据 | 仅合成基准，**无真实厂商标注集** |
| 多实例 | 未实现（单进程额度 + SQLite 预算账本） |

**判定：具备 Stable 发布条件。** Stable 的定义是「维护者当前选择的公开正式发布渠道」，
不等于「所有第三方集成已通过生产认证」；上表中「未联调 / 未实现」的项不因发布正式版而改变。

---

# 历史记录 — Search Hub v0.1.2 RC

日期：2026-11-14 ｜ 目标：判断 v0.1.2 是否具备**公开测试版（Release Candidate）**发布条件

> 判定口径：只有「实跑」证据才算通过。静态检查、契约测试、替身脚本一律标注为 B 档，不作为发布依据。任何未执行项写 BLOCKED 并说明缺什么。

## 1. Git 状态

| 项 | 值 |
|---|---|
| 分支 | `main`（远端默认分支） |
| HEAD | `44e8720`（Docker 验收通过的提交；其后仅追加文档提交，精确值见 GitHub） |
| 本轮提交 | `9d43665` 文档一致性、`4a5ef8e` RC 验收强化、`9dec043` 远端验收准备、`44e8720` Docker 验收修复 |
| 远端 | <https://github.com/alicia1030su/search-hub>（Public，已 push；未打 tag、未建 Release） |
| 工作区 | 干净（除团队成员并行改动） |
| 历史改写 | 无 |

## 1.1 v0.1.3 增量（2026-11-14）

| 项 | 结果 |
|---|---|
| 测试 | **471**（v0.1.2 为 367）：v0.1.3 逐步加入旧版兼容契约、取消语义回归与脱敏回归 |
| 旧版 Search Hub 兼容适配器 | 已实现；`documented`；**未连接真实 44475**（未授权） |
| 取消语义 | 修复：调用方 abort 由 `network`（可重试）改为 `cancelled`（不可重试） |
| Actions | 全部升级到 `using: node24`，Node.js 20 弃用告警消失 |
| 真实通用搜索 | **仍无进展**：无 Tavily/Bocha/Brave/SearXNG 凭证；不升级为 `live_tested` |
| AC 矩阵 | **PASS 11 / PARTIAL 4 / BLOCKED 1**，与 v0.1.2 相同（没有用测试数量冒充验收状态） |

v0.1.3 的目标是「把可做的集成与文档做对」，不是把未验证项写成已验证。剩余缺口与 §9 一致。

## 2. 测试总数与通过情况

| 套件 | 结果 | 命令 |
|---|---|---|
| Vitest 单元 + 集成 | **471 passed / 25 files**，exit 0 | `corepack pnpm test` |
| Playwright E2E | **5 passed**，exit 0 | `corepack pnpm test:e2e` |
| TypeScript | **0 error** | `corepack pnpm typecheck` |
| Lint（oxlint） | **0 warning / 0 error**，127 files | `corepack pnpm lint` |
| 构建 | exit 0，产出 `apps/api/dist/server.mjs` + `apps/web/dist` + `packages/mcp/dist/stdio.mjs` | `corepack pnpm build` |
| 验收矩阵校验 | PASS，16 项 | `node scripts/ac-matrix.mjs --check` |

## 3. Docker CI 实际执行情况

**已执行，通过。** GitHub Actions `Docker` 工作流在 ubuntu-latest 上跑通全链路：

Run: <https://github.com/alicia1030su/search-hub/actions/runs/43582011942> ｜ commit `44e8720`

| Job | 结果 |
|---|---|
| Install, typecheck, lint, test and build | **success** |
| Browser end-to-end (Playwright) | **success** |
| Image, compose stack, MCP and 11-item acceptance | **success**（items=24 skipped=0 failed=0） |

`CI` 工作流同一提交：<https://github.com/alicia1030su/search-hub/actions/runs/43582011967> — 4 个 job 全部 success。

本机 Docker Engine 仍不可用（`npipe:////./pipe/dockerDesktopLinuxEngine` 不存在，`wsl.exe` 被宿主策略阻断），因此容器证据**全部来自远端 Runner**，本机未做任何绕过。

## 4. 实际构建镜像信息

| 项 | 值 |
|---|---|
| 镜像 | `search-hub:ci` |
| Image ID | `75927d54c37d` |
| 体积 | **506 MB** |
| 基础镜像 | `node:22-bookworm-slim`（运行时已移除 npm/corepack） |
| 运行用户 | uid 1001 `searchhub` |
| 卷 | `sh-ci-43582011942-1_search-hub-data` |
| Trivy | **CRITICAL=0 / HIGH=0**（`ignore-unfixed=1`，阈值 MAX 0/0，未放宽） |

容器实测资源：空载 **58.43 MiB / 1 GiB（5.71%）**，50 次搜索后 **60.41 MiB（5.90%）**，CPU 0.01–0.08%。
崩溃恢复：容器内 SIGKILL server 进程 → restart policy **0→1** 拉起，checkpoint 200，`searches=51` 数据完整。

## 5. 真实 Provider 联调状态

| Provider | 默认地址 | 鉴权 | 状态 | 真实证据 |
|---|---|---|---|---|
| Hacker News | `https://hn.algolia.com` | 无 | **live_tested** | 真实查询返回真实 `https://` URL（本轮 `curl` 200，`clean-install` 自检 3 条，`live-search` 20/20） |
| Tavily | `https://api.tavily.com/search` | `Authorization: Bearer` | `documented` | 仅无效 Key 探测：**401 + `{"detail":{"error":"Unauthorized..."}}`**，证明端点在线与错误信封；无有效 Key → 未联调 |
| 博查 Bocha | `https://api.bochaai.com/v1/web-search` | `Authorization: Bearer` | `documented` | 仅无效 Key 探测：**401 + `{"log_id":"...","message":"Invalid API KEY","code":"401"}`**；无有效 Key → 未联调 |
| Brave | `https://api.search.brave.com/res/v1/web/search` | `X-Subscription-Token` | `documented` | 无 Key **且**本机到该主机超时（`curl` exit 28），双重缺口 |
| SearXNG | 用户自建 | 可选 | `documented` | 无可用实例 |
| Generic HTTP | 用户自建 | 声明式 | `documented` | 本地模拟验证 |
| Mock | — | 无 | `live_tested`（仅测试） | 确定性测试源，**不得作为真实覆盖** |

**结论：Hacker News 是唯一真实联调的搜索源，且它是技术社区垂直检索，不能作为通用网页搜索证据。** 通用网页搜索（Tavily/Bocha/Brave/SearXNG）全部停留在 `documented`。

> 未使用任何真实 API Key；仓库内无 Key、无代理凭证、无内网地址（`scripts/secret-scan.mjs` 工作区 + 全 ref 扫描 0 命中）。

## 6. 16 项 AC 验收矩阵

唯一事实源 `docs/ac-matrix.json`，渲染于 `docs/ac-matrix.md`，由 `scripts/ac-matrix.mjs --check` 门禁。

| 状态 | 数量 | 项目 |
|---|---|---|
| PASS | 11 | AC-03、AC-04、AC-06、AC-07、AC-08、**AC-09（容器 restart + 崩溃恢复）**、AC-10、AC-11、AC-12、AC-14、AC-15 |
| PARTIAL | 4 | AC-01（仅缺字面“未就绪”徽标）、AC-02（无 Brave/SearXNG 凭证）、AC-05（客户端 wall 超带）、AC-16（无真实模型厂商 Key） |
| BLOCKED | 1 | AC-13（无真实 Agent 客户端） |
| FAIL / NOT_IMPLEMENTED | 0 | — |

每一项的 evidence 与 gaps 见 `docs/ac-matrix.md`，本报告不重复统计（避免两套数字）。

## 7. 发现和修复的安全问题（本轮及 v0.1.2 累计）

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | `::ffff:7f00:1` 形式的 IPv4-mapped IPv6 未被识别 | 可绕过 CIDR 黑名单访问回环 | 已修 + 回归用例（直连/代理双模式） |
| 2 | `SearchHubError("blocked")` 因 status 403 被映射成 `auth_invalid` | SSRF 拒绝被误判为 Key 失效，可能停用从未使用的 Key | 已修，应用层错误码原样透传 |
| 3 | 模型 Key 被上游回显后进入 `last_test_error` → 模型列表 / 配置导出 / 备份快照（Gemini 用 `x-goog-api-key`，共享脱敏器不认识） | 明文凭据落库并可被低权限 token 读到 | 已修 + 回归 |
| 4 | 模型 Base URL 只在调用时校验 | 保存非法地址返回 200，之后静默降级 | 已修（创建即 403） |
| 5 | 降级阶段耗时写到 `stats` 而非 `stats.timing` | 指标恒缺 | 已修 |
| 6 | `/api/health`（匿名）返回代理 `host:port` | 内网拓扑泄露给未认证调用者 | 已修（仅三元组，全量在 admin 端点） |
| 7 | Key 掩码仅末 4 位 | 同后缀多把 Key 无法区分 | 已修（首 4 + 末 4） |
| 8 | `clean-install.mjs` 未声明变量 | 重启/备份/恢复三段被静默跳过（假通过） | 已修，现在失败会退出非 0 |
| 9 | Dockerfile `chown -R /app/apps` | 每个文件复制进新层，镜像接近翻倍 | 已修（`COPY --chown`） |
| 10 | `prod-deps` 从含 devDeps 的层裁剪 | vite/esbuild 可能进入运行时 | 已修（独立全新安装） |
| 11 | 上游错误正文拼进 message | 凭据可能进日志/响应 | 已修（按本次请求 header 值精确清洗 + 已知形态兜底） |
| 12 | `deep-research/SKILL.md` 让 search-scope token 调 `/api/admin/models` | 技能按文档执行必然 403；用户会以为 token 坏了 | 已修：文档改为索取 `chatModelId`，并新增回归断言 |
| 13 | 首次初始化的 setup token 被写入启动日志 | 公开仓库的 Actions 日志/产物会暴露一次性 token，未初始化实例可被抢占 | 已修：只打印 token 文件路径，不再打印值 |
| 14 | E2E 使用固定管理员密码，失败 trace 会上传 | 固定口令进入公开 artifact | 已修：每次运行随机生成 |
| 15 | `push` 只监听 `main`，仓库分支是 `master` | 首次推送后 CI/Docker 工作流不会触发 | 已修：两个工作流同时监听 main/master |

代理安全边界（本轮复审中，见 §9 未完成项）：默认 `untrusted` 下回环/RFC1918/CGNAT/链路本地/`.local`/云元数据在**发起代理请求前**被拒，mock 代理 CONNECT 计数为 0；`NO_PROXY` 命中走带连接期守卫的直连；代理凭据不可枚举、不落日志。

## 8. 资源使用与性能基线

| 场景 | RSS | Private | 线程 | 句柄 |
|---|---|---|---|---|
| 原生进程空载 | 81.8 MB | 81.6 MB | 16 | 257 |
| 原生进程 50 次搜索后 | 86.4 MB | 85.3 MB | — | 254 |
| **容器空载** | **58.43 MiB / 1 GiB（5.71%）** | — | — | — |
| **容器 50 次搜索后** | **60.41 MiB / 1 GiB（5.90%）** | — | — | — |

- 这是 **Windows + Node 22 原生进程**数据，不是容器数据；`docker stats` 因无引擎无法获取。
- AC-05 端到端：调度器层 ratio 0.97–1.06（带内）；本轮分层测量显示 SQLite 写入 P50 0.8ms、融合 0ms、HTTP 开销 2.6ms，**服务端**流水线 ratio 0.93–1.00，但**客户端 wall** 1.26–1.39 仍超带，故 AC-05 保持 PARTIAL。
- 性能分层与 P50/P95/P99 见 [`docs/performance-baseline.md`](./performance-baseline.md)：SQLite 写入 P50 0.8ms、融合 0ms、HTTP 框架 2.6ms —— 三者都不是 1.2–1.4 超额的原因。

## 9. 当前仍未验证的项

| # | 项 | 缺什么 | 状态 |
|---|---|---|---|
| 1 | ~~Docker 镜像构建 / compose / 初始化 / REST / MCP / 重启 / 持久化 / 资源 / Trivy~~ | ~~Docker Engine~~ | **已由 GitHub Actions 完成**（run 43582011942，24/24 PASS） |
| 2 | Tavily / Bocha 真实搜索联调 | 有效 API Key | **BLOCKED**（端点已证实可达：401） |
| 3 | Brave 真实联调 | 订阅 Key **且**网络可达 | **BLOCKED** |
| 4 | SearXNG 真实联调 | 启用 JSON 输出的可达实例 | **BLOCKED** |
| 5 | 模型厂商真实联调（Chat/Embedding/Rerank） | 任一厂商 Key | **BLOCKED** |
| 6 | AC-13 Agent Skills 被真实客户端加载 | Claude Desktop / Cursor | **BLOCKED** |
| 7 | AC-05 客户端 wall 耗时带宽 | 隔离空闲机器复测 | **PARTIAL**（服务端在带内，客户端 1.26–1.39） |

只有 2–7 仍缺证据；**1 已被远端 Runner 的真实执行取代**，不再算 BLOCKED。

## 10. 是否达到公开测试版发布条件

### 结论：**READY（公开预览），仍非 production-ready**

C1（Docker 容器验收）已在 GitHub Actions 真实通过，因此此前"0 项容器验收"这一最大缺口已经关闭。剩余缺口的性质是**外部凭证与第三方环境**，不是代码或部署缺陷。

**A 档证据（可对外引用）**

- **471** 个 Vitest + 5 个 Playwright，本地与 GitHub Runner 双处全绿；typecheck / lint 0 错误。
- **镜像真实构建**：`search-hub:ci`，506 MB，`docker build` 在 ubuntu-latest 成功。
- **11 项容器验收 24/24 PASS**：compose 启动、非 root uid 1001、web 产物、health、setup token、初始化、真实 HN 搜索、Key 掩码、重启一致、持久化、资源、崩溃恢复（RestartCount 0→1）、Trivy（CRITICAL=0 HIGH=0）、MCP（9 tools / 真实 URL / REST 一致 / 401）。
- **CI 4 个 job 全绿**：quality、build、e2e、security（含全历史密钥扫描）。
- 密钥三重泄漏扫描 18/18；工作区与全 ref 扫描 0 命中；`pnpm audit` 无已知漏洞。
- Repo 侧：Secret Scanning 与 Push Protection 已启用，Dependabot alerts 已启用，`GITHUB_TOKEN` 默认只读，`main` 分支已设 5 个必需检查且禁止强推/删除。

**仍未验证（发布说明必须写明）**

1. **通用网页搜索 0 个真实联调**：Tavily/Bocha/Brave/SearXNG 全部 `documented`。Hacker News 已真实联调，但它是垂直检索，不能代表通用网页搜索。
2. **模型厂商 0 个真实联调**：全部 `NOT VERIFIED — no credential`。
3. **AC-13 BLOCKED**：无真实 Agent 客户端加载 SKILL.md。
4. **AC-05 PARTIAL**：客户端 wall 1.26–1.39，服务端流水线 0.93–1.00。

**对外表述规则**

允许：

- 「公开预览版。Hacker News 已真实联调；Docker 镜像与容器验收已在 GitHub Actions 通过。」
- 「Tavily / 博查 / Brave / SearXNG 按官方文档实现，尚未完成真实搜索联调。」
- 「模型增强为可选能力，尚未与真实厂商联调。」

禁止：

- 「支持 28 个搜索源」（实为 7 个适配器 + 21 条目录条目）
- 「通用网页搜索已验证」
- 「生产就绪 / production-ready」
- 「AI 摘要已在生产验证」

**发布动作边界**：本轮只完成 push 与 Actions 验收。**未打 Tag、未创建 Release、未发布容器镜像**，这些需要单独授权。

## 11. 发布前检查清单（可执行）

```bash
# 1. 代码与测试
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test && corepack pnpm build
corepack pnpm test:e2e
node scripts/ac-matrix.mjs --check
node scripts/secret-scan.mjs
corepack pnpm audit --audit-level high

# 2. 密钥泄漏（需真实实例）
node tests/scripts/leak-scan.mjs
node tests/scripts/backup-restore.mjs

# 3. 真实搜索（需真实实例 + token）
node tests/scripts/live-search.mjs --url http://127.0.0.1:8787 --token sh_...
node tests/scripts/mcp-live.mjs  --url http://127.0.0.1:8787 --token sh_...
node tests/scripts/search-quality.mjs --url http://127.0.0.1:8787 --token sh_...

# 4. 容器（必须有 Docker）
bash scripts/docker-verify.sh          # exit 0 才算通过

# 5. 真实 Provider（需 Key）
TAVILY_API_KEY=... node tests/scripts/provider-live.mjs --provider tavily
BOCHA_API_KEY=...  node tests/scripts/provider-live.mjs --provider bocha

# 6. 发布动作（需维护者授权，缺一不可）
git remote add origin <url>   # 需授权
git push origin master        # 需授权
git tag -a v0.1.2 -m "..."    # 需授权
```

详见 `docs/release-checklist.md`。
