# 发布就绪报告 — Search Hub v0.1.2 RC

日期：2026-11-14 ｜ 目标：判断 v0.1.2 是否具备**公开测试版（Release Candidate）**发布条件

> 判定口径：只有「实跑」证据才算通过。静态检查、契约测试、替身脚本一律标注为 B 档，不作为发布依据。任何未执行项写 BLOCKED 并说明缺什么。

## 1. Git 状态

| 项 | 值 |
|---|---|
| 分支 | `master` |
| HEAD | `4a5ef8e`（RC 验收强化；基线 `a2e4b4a`） |
| 本轮提交 | `9d43665` 文档一致性、`4a5ef8e` RC 验收强化 |
| 远端 | **无 remote**（`git remote -v` 为空），未 push、未打 tag、未建 Release |
| 工作区 | 干净（除团队成员并行改动） |
| 历史改写 | 无 |

## 2. 测试总数与通过情况

| 套件 | 结果 | 命令 |
|---|---|---|
| Vitest 单元 + 集成 | **366 passed / 25 files**，exit 0 | `corepack pnpm test` |
| Playwright E2E | **5 passed**，exit 0 | `corepack pnpm test:e2e` |
| TypeScript | **0 error** | `corepack pnpm typecheck` |
| Lint（oxlint） | **0 warning / 0 error**，127 files | `corepack pnpm lint` |
| 构建 | exit 0，产出 `apps/api/dist/server.mjs` + `apps/web/dist` + `packages/mcp/dist/stdio.mjs` | `corepack pnpm build` |
| 验收矩阵校验 | PASS，16 项 | `node scripts/ac-matrix.mjs --check` |

## 3. Docker CI 实际执行情况

**未执行（BLOCKED）。** 本机 Docker Engine 不可用：

```text
$ docker info
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running:
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
exit code 1
```

根因（已取证，非推测）：`com.docker.service` 为 `Stopped/Manual` 且当前进程非管理员（`OpenError`）；`desktop-linux` context 的命名管道由 Docker Desktop Linux 引擎创建，后者依赖 WSL2，而 `wsl.exe` 被宿主安全策略列入黑名单（`PROGRAM BLOCKED BY SECURITY POLICY ... cannot be approved or bypassed`）。**未尝试任何绕过。**

已交付可复现链路（B 档：静态与替身验证）：

| 文件 | 作用 |
|---|---|
| `.github/workflows/docker.yml` | GitHub ubuntu-latest：`quality` job（install/typecheck/lint/test/build）+ `container` job（镜像构建 + compose + 11 项验收 + trivy），后者 `needs: quality` |
| `scripts/docker-verify.sh` | 任意 Linux + Docker 主机执行 `bash scripts/docker-verify.sh` |
| `docs/docker-verification.md` | BLOCKED 证据、跑法、每项期望输出、证据等级定义 |

**CI 实际执行链接：无**（仓库没有远端，工作流从未被 GitHub 调度）。这是本报告最关键的缺口：Docker 镜像构建与 11 项容器验收只有 B 档证据（YAML 解析、`bash -n`、`docker compose config --quiet` exit 0、脚本替身三分支）。

## 4. 实际构建镜像信息

**未构建（BLOCKED）。** `docker build -t search-hub:v0.1.2 .` → exit 1（同上错误）。无镜像 ID、无体积、无层信息可报。

替代证据（等价执行路径，B 档）：`node tests/scripts/clean-install.mjs` 在干净目录完成 `install → build → --prod 裁剪 → node apps/api/dist/server.mjs → /api/health 200`，与镜像内执行路径一致（镜像 `COPY --from=build` 产物 + 仅生产依赖）。**但这不等于镜像可构建**，两者在评审里是不同证据等级。

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
| PASS | 10 | AC-03、AC-04、AC-06、AC-07、AC-08、AC-10、AC-11、AC-12、AC-14、AC-15 |
| PARTIAL | 5 | AC-01（容器未验）、AC-02（无 Key）、AC-05（端到端耗时带宽）、AC-09（容器重启未验）、AC-16（无真实厂商 Key） |
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

代理安全边界（本轮复审中，见 §9 未完成项）：默认 `untrusted` 下回环/RFC1918/CGNAT/链路本地/`.local`/云元数据在**发起代理请求前**被拒，mock 代理 CONNECT 计数为 0；`NO_PROXY` 命中走带连接期守卫的直连；代理凭据不可枚举、不落日志。

## 8. 资源使用与性能基线

| 场景 | RSS | Private | 线程 | 句柄 |
|---|---|---|---|---|
| 空载（`node apps/api/dist/server.mjs`） | 81.8 MB | 81.6 MB | 16 | 257 |
| 50 次 RRF 搜索后 | 86.4 MB | 85.3 MB | — | 254 |

- 这是 **Windows + Node 22 原生进程**数据，不是容器数据；`docker stats` 因无引擎无法获取。
- AC-05 端到端：调度器层 ratio 0.97–1.06（带内）；本轮分层测量显示 SQLite 写入 P50 0.8ms、融合 0ms、HTTP 开销 2.6ms，**服务端**流水线 ratio 0.93–1.00，但**客户端 wall** 1.26–1.39 仍超带，故 AC-05 保持 PARTIAL。
- 性能分层与 P50/P95/P99 见 [`docs/performance-baseline.md`](./performance-baseline.md)：SQLite 写入 P50 0.8ms、融合 0ms、HTTP 框架 2.6ms —— 三者都不是 1.2–1.4 超额的原因。

## 9. 当前所有 BLOCKED 项

| # | 项 | 缺什么 | 谁能解 |
|---|---|---|---|
| 1 | Docker 镜像构建 | Docker Engine（本机 WSL 被策略阻断） | 任意有 Docker 的 Linux 主机或 GitHub Actions |
| 2 | `docker compose up` / 管理员初始化 / REST / MCP / 持久化 / 重启 / 资源 / Trivy | 同上 | 同上 |
| 3 | GitHub Actions 实际执行（quality + 11 项容器验收） | 仓库没有远端；工作流从未被调度 | 用户授权 push 到远端后自动触发 |
| 4 | 镜像漏洞扫描（HIGH/CRITICAL） | 无引擎、本机无 trivy | CI（`docker.yml` 已配 trivy 门禁） |
| 5 | Tavily / Bocha 真实联调 | 有效 API Key | 提供 Key 后用 `tests/scripts/provider-live.mjs` |
| 6 | Brave 真实联调 | 订阅 Key **且**网络可达 | Key + 换网络环境 |
| 7 | SearXNG 真实联调 | 启用 JSON 输出的可达实例 | 自建实例 |
| 8 | 模型厂商真实联调（Chat/Embedding/Rerank） | OpenAI/Anthropic/Gemini/Cohere/Jina 任一 Key | 提供 Key |
| 9 | AC-13 Agent Skills 被真实客户端加载 | Claude Desktop / Cursor 等 MCP 客户端 | 在客户端安装并执行 |
| 10 | AC-05 端到端耗时带宽 | 隔离、空闲的机器复测（含容器内） | 有 Docker 的环境 |

## 10. 是否达到公开测试版发布条件

### 结论：**CONDITIONAL**

不是 READY，也不是 NOT READY。理由如下。

**支持发布的事实（A 档证据）**

- **366** 个 Vitest + 5 个 Playwright 全绿；typecheck / lint 0 错误；构建成功。
- 真实网络搜索链路可用（HN 真实返回真实 URL，REST 与 MCP 结果一致，20/20）。
- 密钥不泄漏三重扫描 18/18；工作区与全 ref 密钥扫描 0 命中；`pnpm audit` 无已知漏洞。
- 备份用 Online Backup API，并发写入下 57/57 检查通过；新版本数据库拒绝启动生效。
- 16 项 AC 中 10 项 PASS，无 FAIL、无 NOT_IMPLEMENTED。

**阻止 READY 的事实**

1. **Docker / 容器验收 0 项执行**：镜像从未构建，compose 从未启动，Trivy 从未跑。这是公开测试版最核心的交付形态（README 首推 `docker compose up`），它只有 B 档证据。**任何"可以发布"的说法都必须以"接受这一项未验证"为前提。**
2. **通用网页搜索 0 个真实联调**：Tavily/Bocha/Brave/SearXNG 全部 `documented`。公开用户按 README 配 Key 后能否真正搜到中文/英文结果，本轮没有证据。
3. **AC-05 端到端性能未达标**：服务端流水线在带内，客户端 wall 1.26–1.39 超带，只保留 PARTIAL。
4. **AC-13 完全 BLOCKED**：无真实 Agent 客户端。
5. **CI 从未运行**：没有远端，工作流是"配置完成"，不是"验证完成"。

**给出 CONDITIONAL 的条件（必须全部满足才可对外称"测试版"）**

| 条件 | 验收方式 |
|---|---|
| C1 | 在任一有 Docker 的 Linux 主机执行 `bash scripts/docker-verify.sh` 并 exit 0（或 GitHub Actions 跑通 `docker.yml`） |
| C2 | Release notes 明确写明：仅 Hacker News 完成真实联调；Tavily/Bocha/Brave/SearXNG 为"按官方文档实现、未联调" |
| C3 | Release notes 明确写明：Docker 镜像验收在发布环境未执行（若 C1 未完成） |
| C4 | 至少 1 个通用网页搜索（Tavily 或 Bocha）用真实 Key 跑通 `provider-live.mjs` 并把状态升为 `live_tested`（**强烈建议，非硬性**） |
| C5 | 替换 README 中 `<your-org>` 与 `search.example.com` 占位符为真实地址，并确认 LICENSE 版权主体 |

**明确不允许的表述**

- 不得称"支持 28 个搜索源"（实为 7 个适配器 + 21 条目录条目）。
- 不得称"通用网页搜索已验证"。
- 不得称"Docker 部署已验证"（在 C1 完成前）。
- 不得称"生产就绪 / production-ready"。

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
