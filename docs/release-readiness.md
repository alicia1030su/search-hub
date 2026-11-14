# 发布就绪报告 — Search Hub v0.1.2 RC

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
| 测试 | **384**（v0.1.2 为 367），新增 16 项旧版兼容契约 + 1 项取消语义回归 |
| 旧版 Search Hub 兼容适配器 | 已实现；`documented`；**未连接真实 44475**（未授权） |
| 取消语义 | 修复：调用方 abort 由 `network`（可重试）改为 `cancelled`（不可重试） |
| Actions | 全部升级到 `using: node24`，Node.js 20 弃用告警消失 |
| 真实通用搜索 | **仍无进展**：无 Tavily/Bocha/Brave/SearXNG 凭证；不升级为 `live_tested` |
| AC 矩阵 | **PASS 11 / PARTIAL 4 / BLOCKED 1**，与 v0.1.2 相同（没有用测试数量冒充验收状态） |

v0.1.3 的目标是「把可做的集成与文档做对」，不是把未验证项写成已验证。剩余缺口与 §9 一致。

## 2. 测试总数与通过情况

| 套件 | 结果 | 命令 |
|---|---|---|
| Vitest 单元 + 集成 | **384 passed / 25 files**，exit 0 | `corepack pnpm test` |
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

- **384** 个 Vitest + 5 个 Playwright，本地与 GitHub Runner 双处全绿；typecheck / lint 0 错误。
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
