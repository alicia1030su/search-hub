# 交付验收报告 — Search Hub 0.1.0

日期：2026-11-13 ｜ 基线：用户 PRD（Phase 0–5）｜ 仓库：`C:/Users/TYMO001/WorkBuddy/ai聚合搜索`

## 1. 一句话结论

Search Hub 已从空目录构建为可运行、可配置、可搜索、可被 REST/MCP/Skill 调用的自托管服务：139 项单元/集成测试、4 项浏览器 E2E、真实进程冒烟脚本全部通过。**未完成**：PostgreSQL、Redis 多实例、向量库、更多真实 Provider、Docker 镜像构建验证（本机 Docker 守护进程未运行）、任何第三方真实 API 联调。

## 2. 完成功能

### Phase 0：需求与架构（完成）

- 仓库从空目录初始化，Git 首次提交；工具链实名核验：Node 22.22.2、pnpm 12.18.0、Docker 29.9.2（客户端）。
- 依赖版本以 npm registry 实测为准：Fastify 5.12.8、Drizzle 0.45.4、better-sqlite3 13.1.1、Vite 8.3.8、React 19.3.1、Tailwind 4.3.5、Zod 4.6.7、Vitest 5.1.0、TypeScript 5.9.3。
- **MCP 版本纠偏**：`@modelcontextprotocol/sdk` 1.32.2 只实现到 2025-11-25；官方 v2 拆分为 `@modelcontextprotocol/server` / `client` 2.4.0，实现 2026-07-28。项目采用 v2。
- 文档：`docs/product-mvp.md`（PM）、`docs/architecture.md`（架构师）、`docs/architecture-decisions.md`（主理人裁决）。

### Phase 1：最小完整闭环（完成）

| 能力 | 实现位置 | 证据 |
|---|---|---|
| SQLite + Drizzle + 手写迁移 | `packages/db` | 启动自动迁移；集成测试验证重启保留 |
| 首次初始化（无默认密码） | `apps/api/src/routes/auth-routes.ts` | E2E 首次安装；AC 测试 |
| 管理员登录 / 会话 / CSRF | `apps/api/src/auth.ts` | 无 CSRF → 403；无会话 → 401 |
| Provider 插件架构 | `packages/providers` | 4 个适配器 + 26 条目录 |
| 至少两个可运行适配器 | Brave、SearXNG | 本地 fixture 测试；**未真实联调** |
| Mock Provider + 故障注入 | `builtin/mock.ts` | 单元 + 集成 + E2E 使用 |
| 多 Key 随机/轮询/加权/最少使用/故障切换 | `packages/core/scheduler` | 13 项调度测试 |
| 多源并发 + 超时 + 隔离 + 部分成功 | `packages/core/engine` | 故障隔离集成测试 |
| URL 规范化 + 去重 + RRF | `packages/core/fusion` | 手算 RRF 断言 |
| 搜索实验室（逐源耗时、去重前后、排名） | `apps/web/src/pages/lab.tsx` | 截图与 E2E 验证真实数据 |
| Docker 启动 | `Dockerfile`、`compose.yaml` | **镜像未构建**（见 §5） |

### Phase 2：智能检索（完成，可选增强）

- RRF 融合、Embedding 语义重排、Rerank、AI 摘要（`[n]` 引用）、查询改写、deep 模式。
- 模型适配：OpenAI 兼容 / Anthropic / Gemini；Embedding（OpenAI 兼容 / custom-http + 维度校验）；Rerank（Cohere/Jina 兼容 / custom-http）。
- 检索内容按不可信数据处理：定界块、系统提示约束、注入模式检测。
- 未配置模型时基础搜索不受影响；模型失败时降级并记录错误，不伪装成功。

### Phase 3：对外集成（完成）

- REST：`/api/search`、`/api/search/deep`、任务查询/取消、Provider 目录/健康、管理 API；OpenAPI 3.1 + `/api/docs`。
- MCP：`@modelcontextprotocol/server` 2.4.0；Streamable HTTP + stdio 代理；9 个工具；双协议（2026-07-28 现代信封 + 2025-11-25 传统握手）。
- Agent Skills：`search-web`、`deep-research`、`research-with-citations`，标准 `SKILL.md`。

### Phase 4：Provider 生态（部分完成）

- 已实现 4 类：Brave、SearXNG、Generic HTTP、Mock。
- 目录 26 条：4 builtin + 13 planned + 2 unavailable + 7 generic。**未实现的条目在 UI 中不可创建**，接口返回 501。
- 其余 Provider 未适配：缺可公开验证的官方接口，或属于模型联网搜索，需要单独适配层。

### Phase 5：稳定性与发布准备（部分完成）

- 安全审查、SSRF 测试、并发测试、全新环境冒烟、CI 配置、README 双语与全套文档完成。
- **未完成**：Docker 镜像构建与容器内验收、性能压测（真实 Provider 延迟）、Release 发布（需维护者授权）。

## 3. 修改/新增文件

- Git 跟踪文件 146 个；主要目录：
  - `apps/api`（Fastify、鉴权、路由、服务、MCP 挂载）
  - `apps/web`（React 管理后台 24 个源文件 + 构建产物）
  - `packages/shared|db|core|providers|models|mcp|skills`
  - `tests/unit|integration|e2e|scripts`
  - `docs/` 9 份文档；根目录 README/EN、LICENSE、CHANGELOG、CONTRIBUTING、SECURITY、Dockerfile、compose、CI。
- 未改动工作区之外的任何用户文件。

## 4. 关键架构决策

1. **单进程原子调度 + 有界排队**：`tryAcquire` 临界区无 `await`，100 并发不会突破每 Key 并发上限；队列上限 512、等待 2s，避免突发流量被立即拒绝。
2. **MCP 走官方 v2**：`createMcpHandler().fetch(Request)`，无需 `reply.hijack()`；同一工厂同时服务两个协议时代。
3. **全源失败返回 503**：`status:"failed"` + `failedSources[]`，不再用 200 空结果冒充成功；部分成功仍为 200 + `partial`。
4. **模型是可选增强**：真实适配器，默认关闭；缺模型时快速失败并给出可操作提示，不在请求路径上假装可用。
5. **TypeScript 5.9.3 而非 7.0.2**：TS 7 原生编译器与 Drizzle/Vite 生态缺少兼容证据，选择可验证的稳定线。
6. **SQLite only**：不为“支持 PostgreSQL”写假适配器；数据访问边界已隔离，作为下一阶段工作。

## 5. 测试命令与实际结果

| 命令 | 结果 |
|---|---|
| `corepack pnpm typecheck` | 通过（node + web 两套 tsconfig） |
| `corepack pnpm lint` | 0 warnings / 0 errors（95 files） |
| `corepack pnpm test` | **10 files / 139 tests passed**，约 5–8s |
| `corepack pnpm test:e2e` | **4 passed**（Chromium，12s 内） |
| `bash tests/scripts/smoke.sh http://127.0.0.1:8805` | **SMOKE TEST PASSED**（全新实例：初始化→双源→Key→搜索→故障隔离→Token→MCP） |
| `docker build -t search-hub:local .` | **未执行成功**：本机 Docker 守护进程未运行（`dockerDesktopLinuxEngine` 不可用）。Dockerfile 与 CI job 已提供，但镜像未在本环境构建/验证 |
| 真实 Brave / SearXNG / 模型厂商 | **未联调**：无凭证、无实例 |

测试覆盖重点：

- 100 并发：5 Key × 3 并发 → 恰好 15 个租约，全部 Key 均被使用（排除全局锁作弊）。
- 100 并发 HTTP 搜索：全部成功、响应无密钥、inFlight 归零。
- 429 → 冷却并遵循 `Retry-After`；401 → Key 暂停；5xx → 退避 + 熔断。
- 密钥：API 响应、Key 列表、配置导出、SQLite 文件（明文/Base64）均无明文。
- SSRF：回环、私网、链路本地、云元数据、IPv4-mapped IPv6、重定向跳转均被拦截；白名单仅放行显式主机。
- MCP：legacy 握手、现代信封、混用协议返回 400、9 个工具可发现、`search_web` 真实返回结果。

## 6. 已知问题

1. **Docker 镜像未构建验证**。Dockerfile 已按 pnpm workspace 布局编写，但本机守护进程不可用；这是发布前必须补做的一步。
2. **SQLite only**。PostgreSQL 未实现。
3. **单实例额度**。Key 并发/RPM 在进程内；崩溃重启最多丢失当前 60s 窗口与在途计数，启动按当日事件近似校准；`kill -9` 不构成硬保证。
4. **MCP HTTP 路由缓冲响应体**。当前 `responseMode: "json"`，不支持服务端 SSE 流式通知/订阅。
5. **同步搜索无法凭 taskId 取消**。客户端 abort 会取消服务端请求；`/cancel` 适用于已知 taskId 的场景（如异步客户端）。实验室的“中断请求”走的是 abort，属于真实取消。
6. **未实现**：向量持久索引、多租户、Redis、更多真实 Provider、OAuth。
7. **模型/Provider 真实行为未验证**。mock 测试通过不等于厂商接口通过。

## 7. 安全风险（残余）

| 风险 | 影响 | 现状 |
|---|---|---|
| 崩溃重启额度窗口丢失 | 短时低于真实用量 | 已知限制，SECURITY.md 披露 |
| 进程内限流 | 多副本各自计数 | 多实例不支持 |
| 允许内网白名单 | 可探测被允许主机 | 管理员显式配置 + 审计 |
| 提示词注入 | 摘要可能被诱导 | 定界块 + 系统约束 + 模式检测；仍非保证 |
| MCP 无 OAuth | 仅静态 Bearer Token | Token 可撤销、限流、scope |
| 依赖供应链 | 传递依赖漏洞 | CI 执行 `pnpm audit --audit-level high`；本机未运行 audit |

## 8. 下一阶段计划

1. 在可用 Docker 环境构建镜像，跑容器内首装/重启/健康检查；补 `docker compose` 实测记录。
2. 用真实 Brave Key 与自建 SearXNG 完成联调，更新 `verification: "live_tested"` 并附请求/响应证据。
3. 为 1–2 家模型厂商（如 OpenAI 兼容网关）录制真实摘要/Embedding/Rerank 联调结果。
4. PostgreSQL 方言与迁移；Redis Key 调度 Lua 实现；MCP SSE 流式。
5. 接入真实 Provider（优先 Bocha / Metaso / Tavily，先验证文档再写适配器）。
6. 性能压测（真实延迟、p95、内存）与长时间 soak。

## 9. 当前 Git 状态

- 分支：`master`
- 提交：`b448da1`（本报告随后续提交）
- 工作区：提交后干净；`.data/`、`apps/web/dist`、`test-results/` 均被忽略。
- 未执行任何 push / tag / release。发布需维护者明确授权。

## 10. 验收对照（用户红线）

| 要求 | 状态 |
|---|---|
| 不只是规划书，进入编码 | ✅ 可运行代码 + 测试 |
| 不伪造测试/接口/页面 | ✅ 未实现项显式标注；无假数据页面 |
| 多源并发、故障隔离、部分成功 | ✅ 测试覆盖 |
| 多 Key 调度与额度硬约束 | ✅ 100 并发测试 |
| 密钥加密、掩码、不泄露 | ✅ 三重扫描测试 |
| 搜索核心唯一 | ✅ REST/MCP/Skill 同一 `executeSearch` |
| 可部署 | ⚠️ Dockerfile 就绪，镜像未在本机构建 |
| MCP + Skills | ✅ 双协议 + 3 个 Skill |
| 真实第三方联调 | ❌ 无凭证，明确记录为待联调 |
