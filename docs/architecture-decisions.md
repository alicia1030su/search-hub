# 架构决策记录（主理人裁决）

> 2026-11-13 定稿。本节取代 `docs/architecture.md` 前几版中的待裁决项 D-1…D-6。所有结论以仓库实际代码与可复现测试为准。

| 编号 | 议题 | 裁决 | 依据 |
|---|---|---|---|
| D-1 | 模型能力是否属于本期 | **属于本期，且是真实适配器而非骨架**：Chat（OpenAI 兼容 / Anthropic / Gemini）、Embedding（OpenAI 兼容 / custom-http + 维度校验）、Rerank（Cohere-Jina 兼容 / custom-http）；查询改写、`[n]` 引用摘要、提示词注入检测均已实现并接入 `deep` / `rerank` / `summarize`。未配置模型时基础搜索完全不受影响。 | 用户 PRD 第六–八节；AC-16 改为「可选增强、默认关闭、失败可降级、测试按钮必须真实」 |
| D-2 | REST 路径 | **`/api/search`**（与 OpenAPI、Skills、验收脚本一致） | 已实现并统一 |
| D-3 | 全源失败状态码 | **HTTP 503 + `status:"failed"` + `failedSources[]`**，不用 200 冒充成功；部分成功仍为 200 + `status:"partial"` | `apps/api/src/routes/search-routes.ts`、`tests/integration/search-errors.test.ts` |
| D-4 | MCP 依赖 | **`@modelcontextprotocol/server@2.4.0`（v2 线）**：现代 2026-07-28 envelope + 2025-11-25 传统握手；不引入 v1 `sdk` | `tests/integration/mcp.test.ts` |
| D-5 | 100 并发语义 | **原子占额 + 有界排队**：`acquire` 默认等待 2s、队列上限 **1024**；等待者由 `release()` 唤醒（不是轮询）。池可用但排队超时 → `queue_timeout`；池不可用 → `no_available_key` | `tests/unit/key-limits.test.ts`（峰值恰为 2）、`tests/integration/concurrency.test.ts`（100/100 成功） |
| D-6 | 崩溃额度恢复 | **启动按当日事件近似校准 + 明示残余风险**，不做同步落库。`SIGTERM` 必须 flush；`kill -9` 不构成硬保证 | `README.md`「已知限制」、`SECURITY.md` |
| E-1 | 目录源数量 | 目录 **27** 条 = **5** 个 builtin 适配器（Brave / SearXNG / Hacker News / Generic HTTP / Mock）+ 13 planned + 2 unavailable + 7 generic。对外只能说「5 类已实现适配器」 | `packages/providers/src/catalog.ts`、`providers.test.ts` |
| E-3 | 初始化安全 | 未初始化时必须提供一次性 setup token（env 或 `data/setup-token`）；管理员创建在 `BEGIN IMMEDIATE` 事务内二次校验 | `tests/integration/security-hardening.test.ts` |
| E-4 | Host / 代理边界 | 非健康检查请求校验 Host；`TRUST_PROXY=true` 仅信任回环 | 同上 + `tests/integration/mcp-client.test.ts` |
| E-5 | 生产运行形态 | 运行时执行 `apps/api/dist/server.mjs`，不需要 tsx/TypeScript；构建顺序 install → build → prod install | `tests/scripts/clean-install.mjs`、`docs/deployment.md` |
| E-2 | 默认超时 | 全局 15s、单源 12s、`maxRetries=1`；全局 deadline 优先 | 已实现 |

## 与早期架构稿的差异

| 项 | 早期稿 | 实际实现 |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk@1.32.2` + `handleRequest(req,res,body)` | `@modelcontextprotocol/server@2.4.0` + `createMcpHandler().fetch(Request)`，无需 `reply.hijack()` |
| 初始化 | 可匿名创建首个管理员 | 必须一次性 setup token；并发创建只允许一个成功 |
| Host 校验 | 仅 Origin | Host + Origin 在鉴权前校验，支持 `SEARCH_HUB_ALLOWED_HOSTS` |
| 生产启动 | `node --import tsx src/index.ts` | `node apps/api/dist/server.mjs`（esbuild 产物） |
| 路径 | `/v1/search` | `/api/search` |
| 全源失败 | 200 | 503 |
| 并发满 | 立即 `no_available_key` | 有界排队（2s / 512） |
| 模型 | 仅骨架 | 真实适配器 + 可选阶段 |
| PostgreSQL | Phase 1 支持 | 未实现，SQLite only |
| Redis 多实例 | Phase 1 设计 | 未实现，单进程额度 |

## 仍未实现（不得声称支持）

- PostgreSQL 方言与迁移。
- Redis 多实例 Key 调度与分布式限流。
- 向量库持久索引（Embedding 只用于单次请求内重排）。
- 多租户 / 团队权限。
- MCP SSE 流式订阅（当前 `responseMode: "json"`）。
- Brave / SearXNG / 模型厂商的真实联调（缺凭证或实例）。Hacker News 已真实联调。
- Docker 镜像构建与容器级重启验收（本机 Docker Engine 不可用，见验收报告）。
