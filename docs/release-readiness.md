# 发布就绪报告

## v0.1.14（Release candidate，未发布）

| 项 | 状态 |
|---|---|
| T01–T03 资源工具与缓存修复 | PASS（本地）；最终缓存候选已在 `3860dc9` 同机重跑 |
| T04 资源端点/UI/文档/包与 Docker smoke | 代码完成；M04 最终 evidence SHA 实测 PENDING |
| M04 100k/100/1000 资源基准 | 同 SHA 两次运行：`2306990` 首次 RSS +3,088,384B 超限（FAIL，保留）；第二次 P95 1.9625ms、RSS +1,683,456B、零写、query plan、cleanup 全 PASS。最终 evidence-only SHA 的 M04 结果以同 SHA artifact 为准 |
| T05 版本/CI/Release exact-SHA 门禁 | PASS（本地）：typecheck、lint、118 文件 1438 项 Vitest、47 项 E2E、build、check:docs |
| 资源证据 | PASS：C01 PASS、C08 PASS_NO_OPTIMIZATION、C09 PASS、C12 PASS；8 份 gzip raw + summary + SHA256SUMS，verifier exit 0 |
| 代码 SHA | `7d5e6e9ff1a33360b0c01712280413ac10cd8e90`；evidence-only 提交不改变代码 fingerprint |
| 三平台包/CLI/Node22 | PR PASS：CLI linux-arm64/linux-x64/node22/windows-x64 全部通过；本机 Windows x64 包体/REST/MCP/资源端点/重启持久化 16 项通过 |
| Docker/systemd/upgrade v0.1.13→current | systemd PR PASS；upgrade PR Windows/Ubuntu PASS，v0.1.13 路径 `appliedDiff=[]`；Docker 因 quality 失败未启动，修复后重跑 |
| Draft/finalize、资产/Provenance/GHCR | PENDING；任一步失败保持 draft |

资源证据状态只允许 `PASS`、`PASS_NO_OPTIMIZATION`、`N/A`、`FAIL`、`BLOCKED`；`N/A` 仅用于 C10，P0 门槛不豁免。发布后事实将追加到本节，不改写历史 Stable 记录或 tagged commit。

### M04 同 SHA 波动记录（2306990）

命令：`pnpm exec tsx scripts/bench-resources.mjs --rows 100000 --warmup 100 --requests 1000`。两次均为 `sourceCommit=2306990fd6f1cb0ecd3bc3840778209bcc3cc4f0`、`cleanWorktree=true`、1,000 个原始样本；失败运行不删除、不覆盖。

| 运行 | artifact | 退出码 | SHA256 | P95 | RSS delta | 结果 |
|---|---|---:|---|---:|---:|---|
| 1 | `artifacts/v0.1.14/20261123T074541905Z-f994e535/resources-benchmark.json` | 4 | `7e2a224f82c21ca0e117a42a5d3e7b551a10e8caf2544ba9f58e5fd2ac538074` | 2.1483ms（余量 7.8517ms） | 3,088,384B（超限 991,232B） | FAIL：仅 RSS 超限；P95/零写/query plan/cleanup 通过 |
| 2 | `artifacts/v0.1.14/20261123T074646542Z-1d410edf/resources-benchmark.json` | 0 | `8f1ae3d254436d64f2a673758a9f7357831867596058a6a54f326a6166d4d6ef` | 1.9625ms（余量 8.0375ms） | 1,683,456B（余量 413,696B） | PASS：全部门槛通过 |

最终 evidence-only 提交不改变应用代码，M04 仍在该提交 SHA 上单独重采；发布后把最终 artifact 哈希追加到 main 的 readiness，而不改写 tagged commit。

## v0.1.13 Stable（2026-11-22）

> **口径**：v0.1.13 已正式发布。发布源为 `main` 提交
> `42d5e574992bc29e870480456f4b6154e0c9dc5f`（PR [#38](https://github.com/alicia1030su/search-hub/pull/38)
> 的 merge commit）；候选最终提交为 `4a4c33650a77b41187a7ad9d03b0786111e09c15`。
> 本记录只把真实执行并取得的证据记为 PASS，环境受限项单独说明。

| 项 | 最终状态 |
|---|---|
| 目标版本 | **v0.1.13（Stable）**，前序 Stable 为 v0.1.12 |
| 主题 | 独立远程 CLI `shub`：搜索/深度搜索、来源、状态、诊断、配置、Provider 单源/批量检测 |
| 发布源提交 | **PASS**：`42d5e574992bc29e870480456f4b6154e0c9dc5f`，PR #38 已正常合并 |
| annotated Tag | **PASS**：`v0.1.13` → `314d29e5a47d1b2067ca2cf514e352a9f78c2614` → `42d5e57` |
| 自动化测试 | **PASS（本地 + PR + main）**：1299 项 / 100 文件；CLI 专项 58 项 |
| 浏览器 E2E | **PASS（本地 + PR + main + Docker）**：Playwright 42/42 |
| 类型 / Lint / 构建 | **PASS**：typecheck 0 error；oxlint 0 warning / 0 error；Web/server/MCP/CLI 构建成功 |
| 文档 / 矩阵 / 质量 | **PASS**：`check:docs`、`check:matrix` exit 0；质量自检 11/11（合成数据） |
| 安全 | **PASS**：依赖审计无已知 HIGH/CRITICAL；Secret Scan 0 violation，未扩大白名单 |
| PR 远端门禁 | **PASS**：CI、Docker、systemd、升级/故障注入、CLI packages 5/5 工作流全绿 |
| main 远端门禁 | **PASS**：CI、Docker、systemd、升级/故障注入、CLI packages 5/5 工作流全绿 |
| Windows 服务端包 | **PASS**：tag CI 在 Windows runner 构建、启动并通过 REST/MCP 验收；本地候选包 16/16 |
| Linux x64 / arm64 服务端包 | **PASS**：tag CI 在对应 Linux runner 构建、启动并通过 REST/MCP 验收 |
| Windows / Linux x64 / Linux arm64 CLI | **PASS**：tag CI 在对应 runner 构建 SEA 并连接真实服务端验收 |
| Node 22 便携 CLI | **PASS**：tag CI 与本地 Windows 均连接真实服务端验收 9/9 |
| 跨版本升级 | **PASS（Windows + Linux）**：v0.1.4-beta.6、v0.1.5-beta.1、v0.1.7-beta.3、v0.1.8、v0.1.10、v0.1.11、v0.1.12、v0.1.8-beta.1 全部通过 |
| 本地真实旧包回归 | **PASS**：v0.1.4、v0.1.5、v0.1.7、v0.1.12 → current；管理员、Provider、Key、master.key、会话、任务、健康/预算/批量状态均保留 |
| 正式发布工作流 | **PASS**：[44999060933](https://github.com/alicia1030su/search-hub/actions/runs/44999060933)，10/10 jobs |
| GitHub Release | **PASS**：`prerelease=false`、`draft=false`，`/releases/latest` 返回 v0.1.13 |
| 资产 / SHA256SUMS | **PASS**：8 个资产均 `uploaded`；tag CI 完整下载后 7 条摘要全 OK，本机 API digest 逐条一致 |
| Provenance | **PASS**：8 个资产共享同一 SLSA bundle `attestations/1457501833/2026/11/22/70706299.json.sn`；tag CI 逐包验证通过 |
| GHCR | **PASS**：`0.1.13`、`v0.1.13`、`latest` 同 digest `sha256:731ccb4ed475d154d9b0c79902c75511f0c8362c8df72d5c39518f348d0af941`，平台 `linux/amd64` |
| 真实厂商联调 | 仍为 Hacker News、Crossref、OpenAlex、PubMed 4 个源 |
| 多实例 | **NOT_IMPLEMENTED**：探测锁与预算仍为单进程/SQLite 单机 |

### v0.1.13 CLI 安全与兼容边界

- CLI 只调用 REST API，不打包服务端、SQLite、Redis、Docker、Provider、KeyScheduler、RRF、缓存、健康检测或模型调用。
- URL 优先级为 `--url` > `SEARCH_HUB_URL` > 非敏感本地配置 > loopback 默认值；远程 HTTP、userinfo、query、fragment 均拒绝。
- Token 仅从 `SEARCH_HUB_TOKEN` 或 `--token-stdin` 读取，不写明文配置；错误输出精确脱敏。
- 重定向仅允许同源 GET；跨域重定向与变更请求重定向均拒绝，不转发 Authorization。
- JSON stdout 只有一个合法 JSON 值；NDJSON 明确 `streaming:false`，不伪装实时流。
- 退出码：0 成功、2 参数、3 认证、4 权限、5 网络/TLS/重定向、6 服务/搜索/检测失败、7 超时、8 版本不兼容、130 Ctrl+C。
- `partial` 默认保留结果并返回 0，`--strict` 返回非零；计费搜索 POST 不自动重试。
- Provider 检测先读服务端预检，缺 Key/禁用 Key 跳过，免 Key 需显式开启，付费风险在无人值守模式必须 `--confirm-cost`。
- CLI 接受服务端 `0.1.12` 至 `0.1.x`；不支持的端点明确失败，不把错误当空结果。

### 最终验证记录

| 命令 / 检查 | 执行环境 | 结果 |
|---|---|---|
| `pnpm test --maxWorkers=2` | 本地 + PR/main CI | **PASS**：1299/100，exit 0 |
| `pnpm test:cli` | 本地候选工作树 | **PASS**：58/58，exit 0 |
| `pnpm test:e2e` | 本地 + PR/main/Docker CI | **PASS**：42/42 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 本地 + PR/main CI | **PASS** |
| `pnpm audit --audit-level high` | 本地 + PR/main CI | **PASS**：无已知 HIGH/CRITICAL |
| `node scripts/secret-scan.mjs` | 本地 + PR/main CI | **PASS**：0 violation |
| `pnpm check:docs` / `pnpm check:matrix` / `pnpm quality:eval` | 本地 + PR/main CI | **PASS** |
| PR 五条工作流 | GitHub Actions | **PASS**：CI `44997781867`、Docker `44997781850`、systemd `44997781784`、Upgrade `44997781914`、CLI `44997781898` |
| main 五条工作流 | GitHub Actions | **PASS**：CI `44998417665`、Docker `44998417686`、systemd `44998417704`、Upgrade `44998417741`、CLI `44998417762` |
| 三平台发布包 | tag CI `44999060933` | **PASS**：Windows x64 / Linux x64 / Linux arm64 均在对应 runner 构建、启动并通过 REST/MCP 验收 |
| 三平台 CLI + Node22 | tag CI `44999060933` | **PASS**：4 个 CLI 资产均构建并连接真实服务端验收 |
| Release 资产校验 | tag CI + 本机 API | **PASS**：CI 完整下载后 `sha256sum -c` 七条全 OK；8 个资产均通过 Provenance API 查询 |
| GHCR 三标签 | tag CI | **PASS**：三次 push digest 一致，push 后 imagetools inspect 再次读到同一 digest |

### 缓存升级证据口径

- `v0.1.4`–`v0.1.6` 使用进程内 `Map` 缓存，没有 `search_cache` 表；只有“表确实不存在 + 缓存 API 明确 404/not_implemented”才归类为 `legacy-memory-only`。
- `legacy-memory-only` 不伪造旧持久行保留，但升级后必须建立新持久缓存，warmup 后 `entries>0`、SQLite `hit_count` 增长且 `stats.cached=true`。
- `v0.1.7+` 持久缓存要求指纹未变时旧行必须复用；指纹合法变化时允许新行复用，但必须证明真实命中。
- 数据库不可读、API 异常、缓存种子失败、条目缺失或证据歧义一律 FAIL，不回退到“只看 cached 字段”。

### 发布事实

- Release：<https://github.com/alicia1030su/search-hub/releases/tag/v0.1.13>，发布于 `2026-11-22T07:39:45Z`，并已由 `/releases/latest` 确认为 GitHub Latest。
- 资产 8 个：
  - `search-hub-v0.1.13-windows-x64.zip`：74,154,773 bytes，`9d0cba1d02a1165e1b19049fea1f92bb38ff48211dd8021deeacc19886afb3c1`
  - `search-hub-v0.1.13-linux-x64.tar.gz`：49,652,045 bytes，`961aee90d6f571c73658ece28ef1b1643f09aede435232a90fb7b87a50de4a1f`
  - `search-hub-v0.1.13-linux-arm64.tar.gz`：49,490,629 bytes，`7598b5287e12fceff01cd29872cd2dd5febbc4f2bf62a88e4173a046c5a73e11`
  - `shub-v0.1.13-windows-x64.zip`：34,627,934 bytes，`2f7c9e218ddbd2b50342d289476f0084e54026eb37bb7899e0b1d96f379dc021`
  - `shub-v0.1.13-linux-x64.tar.gz`：42,185,532 bytes，`861519e48861dfb41941e099e99ef9e9030d7207900c9d854af9d24bc536722a`
  - `shub-v0.1.13-linux-arm64.tar.gz`：42,103,187 bytes，`6e6694b60fe253355a8d90143d64079cc732edfb94e03f3d8bb72441ac8000b4`
  - `shub-v0.1.13-node22.tar.gz`：428,094 bytes，`cb3d382f27ed83c39052b44a07e682520f77c333ef203faad3fe3130ae674d4f`
  - `SHA256SUMS`：689 bytes，`39c9d79a4975b3129545fe3e98cce92fd5bacda900ec57c0b3b0f612109ecf20`
- 八份资产均在同一份 SLSA Provenance 的 subject 中；bundle 为 `attestations/1457501833/2026/11/22/70706299.json.sn`。
- GHCR `ghcr.io/alicia1030su/search-hub` 的 `0.1.13`、`v0.1.13`、`latest` 三个标签均指向 `sha256:731ccb4ed475d154d9b0c79902c75511f0c8362c8df72d5c39518f348d0af941`。

### 未通过 / 受限

| 项 | 状态 | 说明 |
|---|---|---|
| 本机完整大资产下载 | **BLOCKED（宿主网络）** | 本机使用 Release API digest、`SHA256SUMS` 与 Provenance API 交叉核验；tag CI 已在 runner 上完整下载全部资产并执行字节级校验 |
| 本机独立读取 GHCR manifest | **BLOCKED（凭证可见性）** | 当前 GitHub 凭证无 `read:packages`；发布 job 使用已认证 `docker buildx imagetools inspect` 完成 push 后复核 |
| `gh release verify` 的 Tag 级 attestation 显示 | **NOTE** | 该命令未列出 asset attestation；直接 Provenance API 与 tag CI 的 `gh attestation verify` 均确认 8 个资产有有效记录 |
| 真实厂商联调 | **受限** | 仅 4 个源有真实网络证据 |
| 质量评测数据 | **受限** | 只有合成基准，无厂商标注集 |
| 多实例 | **NOT_IMPLEMENTED** | 无跨进程协调者 |

---

## v0.1.12 Stable（2026-11-21）

> **口径**：v0.1.12 已正式发布。以下结果均对应最终 `main` 提交
> `caa5e1164aabe4ec86b42d1348a3f68baad32988`（PR #36 的 merge commit）；本地测试对应
> 候选提交 `7a17c7713c40a5c635fb1a9f384daff3cafa2786`。未执行或环境受限的项目单独标记，
> 不沿用旧版本记录，也不以静态检查替代实跑。

| 项 | 最终状态 |
|---|---|
| 目标版本 | **v0.1.12（Stable）**，前序 Stable 为 v0.1.11 |
| 发布源提交 | **PASS**：`caa5e1164aabe4ec86b42d1348a3f68baad32988`，PR [#36](https://github.com/alicia1030su/search-hub/pull/36) 已正常合并 |
| 自动化测试 | **PASS（本地 + main CI）**：1241 项 / 96 文件，`vitest run --maxWorkers=2` 与远端 CI 均 exit 0 |
| 浏览器 E2E | **PASS（本地 + main CI + Docker CI）**：Playwright 42/42 |
| 类型 / Lint / 构建 | **PASS**：typecheck 0 error；oxlint 0 warning / 0 error；Web、server、MCP 构建成功 |
| 文档 / Provider 矩阵 / 质量门禁 | **PASS**：`check:docs`、`check:matrix` 均 exit 0；质量自检 11/11（合成数据，不代表厂商优胜） |
| 迁移 | 0001–0011；0010 归档并保守重算 `connect` 物理跳账本，只增不减、幂等；0011 增加诊断 sanitized 标记，旧行默认 false、原文不改，读取时 withheld |
| main CI | **PASS**：[44894690489](https://github.com/alicia1030su/search-hub/actions/runs/44894690489)，6/6 jobs |
| main Docker | **PASS**：[44894690454](https://github.com/alicia1030su/search-hub/actions/runs/44894690454)，3/3 jobs；容器验收 24/24、0 skipped，真实 HN 搜索与预算 `1→1`，Trivy CRITICAL=0 / HIGH=0 |
| main systemd | **PASS**：[44894690461](https://github.com/alicia1030su/search-hub/actions/runs/44894690461)，启动 / 重启 / 停止 / 升级 / 回滚通过 |
| 真实 v0.1.11 → current 升级 | **PASS（远端）**：[44894690455](https://github.com/alicia1030su/search-hub/actions/runs/44894690455)，Windows/Linux 对应 runner 实跑；供应链审计通过 |
| 依赖审计 / Secret Scan | **PASS**：无已知 HIGH/CRITICAL；本地 434 个文本文件 / 74 refs，0 violation；未修改白名单 |
| 正式发布工作流 | **PASS**：[44895493016](https://github.com/alicia1030su/search-hub/actions/runs/44895493016)，Gate、三平台包、Stable Release、GHCR 6/6 jobs |
| annotated Tag | **PASS**：`v0.1.12` → 标签对象 `3307de9c01d94b157b6d0b2a2accb747522788a1` → `caa5e11` |
| GitHub Release | **PASS**：`prerelease=false`、`draft=false`，`/releases/latest` 返回 v0.1.12 |
| 三平台资产 / SHA256SUMS | **PASS（tag CI + API 交叉核验）**：4 个资产均 `uploaded`；三条摘要与 GitHub API digest 逐条一致，`SHA256SUMS` 自身 digest 一致 |
| Provenance | **PASS**：4 个资产共享同一 SLSA bundle；签名身份为 `release.yml@refs/tags/v0.1.12`，源提交 `caa5e11`，invocation 为 run `44895493016` |
| GHCR | **PASS（发布 job 已认证核验）**：`0.1.12`、`v0.1.12`、`latest` 同 digest `sha256:49270daeb47effb1c0d197b9cf31c090e453d4541af1f47fef1689cd7c7469b9`，平台 `linux/amd64` |
| 本机完整资产下载 | **BLOCKED（宿主网络）**：大文件传输 `unexpected EOF`；未把截断文件当作校验依据。tag CI 已完整下载并执行 `sha256sum -c`，本机另做 API digest / attestation subject 交叉核验 |
| 最终独立复审代理 | **BLOCKED（运行环境内存不足）**：恢复后再次失败，未伪造其结论；此前审查发现已修复，最终门禁证据见上 |
| 真实厂商联调 | 仍为 Hacker News、Crossref、OpenAlex、PubMed 4 个源；其余未联调 |
| 多实例 | **NOT_IMPLEMENTED**：同源探测锁与 SQLite 预算均为单进程 |

### v0.1.12 修复范围

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
7. URL 脱敏覆盖 literal、URI/query-form、双重/三重百分号编码、混合编码、Unicode/emoji
   与 8192 字符超长 Key；使用 token 偏移映射，避免超长正则异常。

### 最终验证记录

| 命令 / 检查 | 执行环境 | 结果 |
|---|---|---|
| `pnpm check:docs` / `pnpm check:matrix` | 本地候选工作树 | **PASS**，exit 0；catalog 58 / builtin 50 / live_tested 4 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 本地候选工作树 + main CI | **PASS**；类型 0 error、lint 0 warning / 0 error、构建成功 |
| `pnpm test` | 本地候选工作树 + main CI | **PASS**：1241/96，exit 0 |
| `pnpm test:e2e` | 本地构建 + main CI + Docker CI | **PASS**：42/42，exit 0 |
| `pnpm audit --audit-level high` | 本地候选工作树 + main CI | **PASS**：无已知漏洞 |
| `node scripts/secret-scan.mjs` | 本地候选工作树 + main CI | **PASS**：434 个文本文件 / 74 refs，0 violation；未修改白名单 |
| launcher / updater / fault injection | 本地 Windows + main CI | **PASS**：生命周期、安装回滚、下载/校验/架构/迁移回滚故障注入全部通过 |
| Windows x64 候选包 | 本地 Windows | **PASS**：构建、启动、REST/MCP、重启持久化 |
| Upgrade / Docker / systemd | GitHub Actions `main` | **PASS**：三条流水线全部 success |
| 三平台发布包 | tag CI | **PASS**：Windows x64 / Linux x64 / Linux arm64 均在对应 runner 构建、启动并通过 REST/MCP 验收 |
| Release 资产校验 | tag CI + 本机 API | **PASS**：CI 完整下载后 `sha256sum -c` 三条全 OK；4 个资产均通过 Provenance 验证 |
| GHCR 三标签 | tag CI | **PASS**：三次 push digest 一致，push 后 imagetools inspect 再次读到同一 digest |

### 发布事实

- Release：<https://github.com/alicia1030su/search-hub/releases/tag/v0.1.12>，发布于
  `2026-11-21T10:43:54Z`，并已由 `/releases/latest` 确认为 GitHub Latest。
- 资产 4 个：Windows x64 74,154,467 bytes / Linux x64 49,651,434 bytes /
  Linux arm64 49,491,170 bytes / SHA256SUMS 307 bytes。
- 资产摘要：
  - Windows x64：`747e0cc7420b2ed62d787ed579a92f0fa15d589776d080d1554b953a81024f61`
  - Linux x64：`27d393265809fd5be6db2126629ef907706c4954537b53e024ab12b56cb483d1`
  - Linux arm64：`a86f62c386b739f22b687b931524c7792fc6b08717f07f987931d0e8fff394b8`
  - SHA256SUMS：`819ef563cfb26a72e440d8be7389f3f7abdc68673abe58c519cbb643501e3003`
- 四份资产均在同一份 SLSA Provenance 的 subject 中；bundle 为
  `attestations/1457501833/2026/11/21/70503594.json.sn`，builder 为
  `alicia1030su/search-hub/.github/workflows/release.yml@refs/tags/v0.1.12`。
- GHCR `ghcr.io/alicia1030su/search-hub` 的 `0.1.12`、`v0.1.12`、`latest` 三个标签均指向
  `sha256:49270daeb47effb1c0d197b9cf31c090e453d4541af1f47fef1689cd7c7469b9`。

### 未通过 / 受限

| 项 | 状态 | 说明 |
|---|---|---|
| 本机完整资产下载 | **BLOCKED（宿主网络）** | 大文件传输 `unexpected EOF`；tag CI 已完整下载并做字节级 SHA256 与密码学 Provenance 验证，本机另做 API digest / attestation subject 交叉核验 |
| 本机独立读取 GHCR manifests | **BLOCKED（凭证可见性）** | 当前 GitHub 凭证无 `read:packages`，匿名 manifest 请求 404；发布 job 使用已认证 `docker buildx imagetools inspect` 完成 push 后复核 |
| 最终独立复审代理 | **BLOCKED（环境内存不足）** | 两次运行均未产出可送达的详细结论；不将代理复审记为 PASS |
| 真实厂商联调 | **受限** | 仅 4 个源有真实网络证据 |
| 质量评测数据 | **受限** | 只有合成基准，无厂商标注集 |
| 多实例 | **NOT_IMPLEMENTED** | 无跨进程协调者 |

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
