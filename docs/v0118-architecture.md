# Search Hub v0.1.18 搜索核心架构

> 冻结契约：`docs/v0118-prd.md` §3–§9 与附录 B1–B8。本文把这些验收口径落到模块、类型、函数和测试；若正文与附录冲突，以附录为准。
>
> 审计基线：`main@ea0a35dea23517584b29995fcaae4d5b7fdaf8f6`；实现分支：`feat/v0118-search-core`。
>
> 本文只规定 v0.1.18 增量。鉴权、CSRF、SSRF、Key 池、限流、备份/DR、升级与发布基础设施继续复用。

## 1. 现状、目标与非目标

### 1.1 已确认的现状

- `packages/core/src/engine/search-engine.ts:68` 把 `perProviderLimit` 硬截到 50；`:176` 在融合后直接 `slice(0, limit)`，模型阶段只能看到已截断结果。
- `packages/core/src/fusion/fuse.ts:101` 只按同域标题 Jaccard 合并，未比较正文，存在误合并。
- `apps/api/src/services/search.ts:758` 的 Deep 最多三次独立检索，使用原始 URL 合并，并在 `:885` 直接累加各查询归一化分数。
- `apps/api/src/services/search.ts:941` 与 `:969` 的模型阶段忽略 `_signal`；`packages/models/src/{embeddings,rerank}.ts` 的接口与 fetch 未接收 `AbortSignal`。
- `apps/api/src/services/search.ts:179` 会因健康门禁移除 Provider；这与 B1“不健康也必须保留并报告失败”不同，必须调整新策略路径的选择逻辑。
- `packages/shared/src/schemas.ts:32` 的 `perProviderLimit` 上限为 50，且 `mode` 有默认值，无法区分缺省与显式 `basic`。
- `apps/api/src/services/cache.ts` 与 `packages/db/src/schema.ts` 已有有界 SQLite 缓存、过期/LRU 索引、事务 totals、singleflight 和旧 `search_cache` 行；不得另建缓存。
- `apps/api/src/services/runtime-monitor.ts` 与 `scripts/lib/resource/*`、`scripts/resource-doctor.mjs`、`scripts/test-lowmem.mjs` 已提供资源采样/进程所有权/低内存工具；不得新增常驻第二监控体系。
- `packages/core/src/evaluation/*` 已有离线指标、分类、movement、实验持久化能力；真实质量证据必须新增人工 qrels 与 live 配对协议，不能复用 synthetic fixture 的结论。

### 1.2 架构目标

1. 一条共享 SearchService 流水线服务 REST、MCP、CLI、Skills、流式和 Lab，禁止入口复制算法。
2. 候选召回、去重、基础融合、模型重排、最终截断完全分离；所有中间集合有界。
3. 取消与 deadline 是不同事实：外部取消为 `cancelled`，deadline 为 `failed + timeout`；每个任务只有一个终态。
4. 新策略可解释、可降级；旧请求契约与旧缓存保持兼容。
5. 质量结论由冻结协议和原始证据支撑；证据不足必须显式输出。

### 1.3 非目标

不训练模型、不无限深搜、不自动浏览、不承诺所有页面可读、不重做安全/DR/Provider 插件/UI 框架、不以清空缓存完成升级、不把临时流式结果写历史或指标。

## 2. 总体分层与依赖方向

```text
REST /api/search, /api/search/deep, /api/search/stream, /api/web/read
MCP tools / CLI commands / Skills / Admin Search Lab
                         │
                         ▼
apps/api/src/services/search.ts（唯一编排、任务状态、缓存、singleflight）
       │                  │                    │
       ▼                  ▼                    ▼
packages/core          packages/models     apps/api/src/services
strategy/router        chat/embedding/      cache/singleflight/
candidate/fusion/deep  rerank（带 signal）  health/settings
       │
       ▼
packages/providers（Adapter）→ SafeFetch（SSRF、重定向、物理请求计数）
       │
       ▼
packages/shared（Zod schema、类型、URL/文本规范化）

packages/db（任务、缓存、质量、审计、资源设置）
packages/runners（worker_threads：正文规范化、离线评测；隔离 Chromium）
scripts/lib/resource + resource-doctor（采样、预算、子进程所有权）
```

规则：

- `shared` 不得依赖 API/core；`core` 不得依赖 Fastify、SQLite 或具体模型实现。
- 模型阶段由 SearchService 注入，core 只产生有界 `RankingInput`。
- 流式与 Lab 调用同一个 `SearchService.execute`，不得各自实现检索。
- 所有网络出口继续经过 `SafeFetch`；HTTP 预算必须在物理请求发出前原子预留。

## 3. 多阶段候选池与 B1 计数契约

### 3.1 新模块与职责

| 文件 | 类型/函数 | 职责 |
|---|---|---|
| `packages/core/src/engine/provider-selection.ts` | `ProviderCandidate`、`selectProviders()` | B1 的 group/providers/enabled 排序、能力过滤、最多 8 个；返回 requested/selected 计数 |
| `packages/core/src/engine/candidate-pool.ts` | `RawCandidate`、`CandidatePool`、`normalizeCandidates()`、`pollTruncate()` | 原始行校验、规范化 URL、400 条轮询截断、计数与原因 |
| `packages/core/src/fusion/fuse.ts` | `dedupeResults()`、`fuseWithRrf()`、`orderByBaseRanking()` | 精确/近标题去重、基础排序、未舍入 RRF |
| `packages/core/src/engine/search-engine.ts` | `executeSearch()`、`buildResponse()` | 单轮编排、funnel、最终序列化；不再提前取 limit |
| `packages/shared/src/types.ts` | `CandidateFunnel`、`TruncationReason`、`SearchFunnel` | 对外计数与截断原因 |
| `packages/shared/src/schemas.ts` | `searchRequestSchema` | 新字段、1–100 上限、strategy/mode 冲突校验 |

### 3.2 Provider 选择（B1）

`selectProviders(request, runtimes, capability)` 固定执行：

1. `group` 存在时优先于 `providers`；group 成员按 `providerId` 升序。
2. 无 group、有显式 `providers`：按请求顺序去重。
3. 两者均无：enabled Provider 按 `providerId` 升序。
4. 仅过滤 `enabled`、能力匹配（缺省 `raw_search`）、Adapter 可用三项。
5. 不因不健康、熔断、无 Key、配额或延迟而静默移除；派发后失败进入 `failedSources`。
6. 取前 8 个为 `selectedProviderIds`，返回 `requestedProviderCount`（去重后的请求/group 成员数）与 `selectedProviderCount`。

健康、延迟、优先级、配额只参与 §7 的调度/解释，不得改写 B1 的 `selectedProviderIds` 顺序。

### 3.3 召回与截断算法

1. 最终 `limit` 为 1–100；`perProviderLimit` 为可选 1–100。
2. 缺省 `perProviderLimit = min(100, limit + 3)`，**不再除以 Provider 数**。显式值原样使用。单 Provider、`limit=100` 时必须能返回 100 条。
3. Adapter 返回行先按 Provider 内 `rank ASC, normalizedUrl ASC` 排序，再按 `selectedProviderIds` 顺序逐名次轮询（rank=1 各源、rank=2 各源……），最多追加 400 条。此阶段**不去重**。`rawReceived` 定义为进入该 400 条池、随后进入校验/去重的行数；Adapter 实际返回总数记 `upstreamReceived`，池外丢弃记 `rawPoolTruncatedCount`，二者必须显式报告，但不破坏 B1 以 `rawReceived` 为起点的恒等式。
4. 空标题、非法/空规范化 URL 计入 `invalidDropped`，不进入 eligible。
5. 对 400 条池先去重，再按模式基础排序截 200 条作为 `rankingInput`：
   - RRF：`fusionScore DESC, bestRank ASC, sourcesCount DESC, normalizedUrl ASC`。
   - basic：`rank ASC, sourcesCount DESC, normalizedUrl ASC`。
6. Rerank/Embedding 输入为全部 `rankingInput`（≤200），每批最多 50，按基础排序确定性分批；最终才截 `limit`。
7. 所有比较使用未舍入值；输出 `score`、`fusionScore` 保留 6 位小数。

若 Adapter 违反 `limitPerProvider` 返回更多行，不静默丢弃：实际总数进入 `upstreamReceived`，400 条池外数量进入 `rawPoolTruncatedCount`，池内行继续执行 B1 恒等式。

### 3.4 B1 计数恒等式

`stats.funnel` 必须包含以下整数：

```text
rawReceived = invalidDropped + eligible
eligible    = exactDuplicateDropped + nearDuplicateDropped + dedupedCount
dedupedCount = candidateTruncatedCount + candidateSelectedCount
rankingInputCount = candidateSelectedCount
rerankInputCount  = rerankApplied ? candidateSelectedCount : 0
returnedCount <= min(limit, candidateSelectedCount)
candidateSelectedCount <= 200
```

兼容字段映射：`rawCount=rawReceived`、`dedupedCount` 保持旧含义、`fusedCount=dedupedCount`、新增 `returnedCount=results.length`。`candidateTruncatedCount` **仅指去重后 200 条 rankingInput 截断数量**，等于 `rankingInputTruncatedCount`；400 池截断单独记 `rawPoolTruncatedCount`，不得混入 `candidateTruncatedCount`，否则无法满足 `dedupedCount = candidateTruncatedCount + candidateSelectedCount`。

`truncationReasons[]` 使用稳定 code：`provider_limit`、`raw_pool_400`、`ranking_input_200`、`result_limit`、`deep_query_limit`、`deep_round_limit`、`provider_query_budget`、`http_budget`、`deadline`。每项含 `stage`、`limit`、`observed`、`dropped`，不得只少返回而不解释。

### 3.5 测试落点

- `tests/unit/search-engine-recall.test.ts`：保留单 Provider 100 条、同标题不同正文；补 8 Provider×100→400 轮询、401 边界、显式 perProviderLimit=100、limit 最终截断。
- `tests/unit/candidate-pool.test.ts`：B1 五条恒等式、无效行、400/200 精确边界、truncationReasons、输入排列不改变轮询结果。
- `tests/unit/fusion.test.ts`：RRF/basic tie-break、6 位输出、近标题正反例。
- `tests/integration/search-service-quality.test.ts`：第 21–100 条含高相关结果，重排后进入 top 10；最终仍 ≤limit。

## 4. 取消、deadline 与任务状态机（B2）

### 4.1 模块

- `apps/api/src/services/search-task-state.ts`：`SearchTaskState`、`TaskTransition`、`SearchTaskCoordinator`。
- `packages/core/src/engine/cancellation.ts`：`SearchAbortContext`、`throwIfCancelled()`、`remainingMs()`。
- `apps/api/src/services/search.ts`：任务表读写、控制器注册、最终提交。
- `packages/shared/src/types.ts`：沿用 `SearchTaskStatus = running | completed | partial | failed | cancelled`。

### 4.2 状态迁移

```text
running ──全部必需阶段成功──────────────→ completed
        ├─至少一个 Provider/阶段失败且有可用结果→ partial
        ├─无可用结果或 deadline────────────→ failed
        └─外部取消────────────────────────→ cancelled
```

- 四类终态不可再迁移；同任务状态提交使用数据库条件更新 `WHERE id=? AND status='running'`，只有 `changes=1` 的提交生效。
- 终态后的顺序取消返回 409；并发重复取消幂等返回当前状态，不重复写历史/缓存。
- 外部信号包括 HTTP 断开、任务取消 API、调用方 `AbortSignal`、服务 shutdown，统一 `cancelled`。
- deadline 使用独立 timer/截止时间，到期为 `failed` 且错误含 `timeout`；不能因 combined signal 把 deadline 误判成用户取消。
- 开始前取消：`cancelled`、空结果、0 上游调用。
- 运行中取消：立即停止新查询、新分页、新模型批次；在飞调用 ≤100ms 内收到 abort。已成功且通过校验的候选允许完成本地有限融合，保存在 `results`，状态仍 `cancelled`。
- 取消不写响应缓存、不把已有结果清空、不新增 Provider 失败；取消前真实错误可保留。
- 终态提交后清理 timer、abort listener、controller、singleflight 引用与流式订阅。

### 4.3 全链路 signal

`RerankModel.rerank(query, documents, topK?, signal?)`、`EmbeddingModel.embed(texts, signal?)`、chat/rewrite/summary 增加可选 signal，并逐层传给 `fetch(..., { signal })`。每个批次前检查 signal/deadline；禁止在 abort 后继续批次。模型接口保持可选参数，旧 fake/实现无需 Breaking Change。

### 4.4 测试落点

- `tests/unit/search-service-cancellation.test.ts`：保留已 abort 不调用模型；补在飞 abort、≤100ms、无后续批次、已有结果保留、不写缓存。
- `tests/unit/search-task-state.test.ts`：非法迁移、终态后取消 409、并发取消幂等、deadline vs external cancel。
- fake-clock：t=0 启动、t=100ms 取消、之后无新调用、deadline 同刻只终态一次、timer/listener 全清理；同一致命重复 20 次结果一致。

## 5. Deep Search 2.0：有界多轮与 B3 分层融合

### 5.1 模块与预算

新增 `packages/core/src/deep/{query-plan,budget,fusion}.ts`：

- `QueryPlan`：`queries: DeepQuery[]`，`DeepQuery={queryId,query,kind,weight,round}`。
- `SearchBudget`：`tryReserveProviderQuery(round,queryId,providerId)`、`tryReserveHttp()`、`reserveModelCall()`、`snapshot()`。所有预留同步、原子、发请求前执行。
- `runDeepSearch()`：最多 2 轮迭代；`fuseDeep()`：B3 分层 RRF 与 queryOrigins。
- `apps/api/src/services/search.ts:runDeep` 改为调用上述 core 编排，不再使用三次 `Promise.all` + Map 累加。

预算：≤4 个去重查询、≤2 轮、≤32 `providerQueryCalls`、≤64 `httpRequests`；总 deadline 默认 30s、上限 120s，所有子调用共享同一个绝对 deadline。`providerQueryCalls` 每 `(round,queryId,providerId)` 首次逻辑派发计 1，失败也计，重试不新增；`httpRequests` 覆盖分页、重试、Provider 内重定向，发请求前预留；缓存命中计 0；`modelCalls` 单独计数。

执行顺序：

1. round 1 只执行原查询 q1，确保原始意图先获得结果。
2. 根据 round 1 结果和可用模型生成本地确定性改写/可选扩展；无模型时使用规则改写，并在 `degradations` 标记 `expansion_skipped`。
3. 生成的查询经 NFKC + casefold + 空白折叠去重，按确定性顺序编号 q2…；round 2 执行剩余查询，最多补足 4 个。
4. 每个 `(query,provider)` 由资源预算限流；达到任一上限立即停止派发，已有结果正常融合并标记 `budgetExhausted`。

Deep 的 400 条原始池按每个实际查询独立应用；不在单查询内提前截 200。各查询池统一做跨查询精确/近标题去重，得到有界并集（最多 4×400=1600），再按 B3 `deepScore` 截 200 作为最终 `rankingInput`，可选 Rerank 也最多读取这 200 条。顶层 B1 funnel 的 `rawReceived/invalidDropped/eligible` 为各查询池之和；跨查询重复计入对应 duplicateDropped，`dedupedCount` 为并集大小，`candidateTruncatedCount=dedupedCount-200`（仅当并集>200），从而保持全部恒等式。

### 5.2 查询身份与公式（B3）

原查询固定 `q1`、`kind=original`、`weight=1.0`；扩展/改写按确定性顺序 `q2...`、`kind=expanded|rewrite`、默认 `weight=0.8`。相同规范化查询只执行一次，后出现来源合并到 `queryOrigins`。

```text
K = 60
local(q,d)      = Σ_p weight[p] / (K + rank[p,q,d])
normalized(q,d) = local(q,d) / max_x local(q,x)
coverage(d)     = queriesContaining(d) / totalQueries
deepScore(d)    = 0.7 × (Σ_q queryWeight[q] × normalized(q,d) / Σ_q queryWeight[q])
                + 0.3 × coverage(d)
```

同一 Provider 在同一查询内重复 URL 只取最佳 rank。未命中查询分子贡献 0，但仍计入分母与 `totalQueries`。排序：

```text
deepScore DESC, queriesContaining DESC, bestRank ASC,
sourcesCount DESC, normalizedUrl ASC
```

不得直接累加不同查询的原始 RRF 或独立归一化分数。`totalQueries` 只包含实际执行/尝试的查询；因预算未派发的查询不计入 coverage，但必须出现在预算解释中。

### 5.3 去重与 queryOrigins

近标题去重仅在同一可注册域，且同时满足：

- 标题 token Jaccard ≥0.82；
- 正文 token Jaccard ≥0.70；
- token 为 NFKC/casefold 后长度 ≥2 的拉丁字母数字词与 CJK 字符 bigram，不去停用词；
- 正文优先已读取正文，否则 snippet，且至少 20 个非空白字符。

缺少可用正文时只做精确 URL 去重，不得凭标题猜测同文。合并保留代表文档与全部来源。

`queryOrigins[]` 每项固定：

```ts
{ queryId, query, queryIndex, kind, round, weight, providerId, rank, score }
```

按 `round, queryIndex, providerId, rank` 排序；`score` 是该来源对 `local(q,d)` 的贡献。合并文档不得丢弃任一来源。

### 5.4 测试落点

- `tests/unit/deep-fusion.test.ts`：B3 手算分数、K=60、未命中分母、coverage、tie-break、queryOrigins 排序与完整性。
- `tests/unit/deep-budget.test.ts`：4 查询/2 轮/32 逻辑调用/64 HTTP 各自边界、失败计数、重试不增逻辑调用、缓存命中 0 HTTP。
- `tests/integration/search-service-quality.test.ts`：跨查询跟踪参数/参数顺序去重、保留双 queryOrigins；弱单源不得胜过强多源。
- `tests/unit/search-engine-recall.test.ts`：同标题不同正文不合并；无正文仅精确去重。
- fake-clock：统一 deadline、任一上限先到即停、部分失败返回已有结果与 degradations。

## 6. 策略、旧 mode 映射与兼容

### 6.1 类型与解析

`packages/shared/src/schemas.ts` 新增：

```ts
strategy: z.enum(["auto","fast","balanced","quality","deep"]).optional()
stream: z.enum(["sse","ndjson"]).optional()
queryExpansion: z.boolean().optional()
maxSubqueries: z.number().int().min(1).max(4).optional()
maxRounds: z.number().int().min(1).max(2).optional()
render: z.boolean().optional()
```

`mode` 去掉 Zod 默认值，由 `resolveSearchIntent(request, settings)` 区分缺省与显式值。新增 `ResolvedSearchIntent={strategy?,mode,effectiveStrategy,routeVersion}`。

### 6.2 策略定义

| 策略 | 召回/融合 | 扩展 | 模型阶段 | 最终体验 |
|---|---|---|---|---|
| Fast | 单轮、basic、≤200 rankingInput | 不做 | 无 | 最低延迟 |
| Balanced | 单轮、RRF、≤200 | 仅确定性规则满足阈值且模型可用时 | 可选 | 新策略推荐 |
| Quality | 扩大有界池、RRF 后可选 Rerank | 可选 | Rerank 可选；无模型保持 RRF，不得让基础搜索失败 | 研究/比较 |
| Deep | 多轮、多查询、B3 融合 | 可选 | 扩展/摘要/Rerank 可选 | 复杂问题，非默认 |

### 6.3 旧 mode 等价与冲突

`strategy` 只提供默认基础模式与可选阶段；两者并存时，显式 `mode` 的已请求阶段优先。基础模式不匹配返回 400 `validation_error`，不得存在两个静默竞争的开关。

| strategy | 基础模式与可接受 mode |
|---|---|
| fast | 仅 basic |
| balanced | 仅 rrf |
| quality | rrf；额外接受 rerank，因为 rerank 是 Quality 的可选阶段 |
| deep | 仅 deep |
| auto | 不额外限制旧 mode，按显式 mode 执行 |

- `quality+rerank` 接受：显式 rerank 阶段优先，缺 rerank 模型仍按旧显式 mode 契约 fail-fast 400。
- `quality+basic` 接受：Quality 默认 RRF 加可选 rerank；若显式 rerank 可用则执行，否则保持 RRF。
- 其余基础模式不匹配的组合（如 `fast+rrf`、`balanced+basic`、`deep+rrf`）返回 400。
- 只传旧 mode：兼容路径，旧响应字段不删、类型不变；缺陷修复可改变错误结果。
- 只传 strategy：新路径，返回 `strategy`、`route`、`appliedStages`、`degradations`。
- 都不传：沿用 SettingsService 默认 mode（当前 basic），不改变旧客户端成本/行为。
- `/api/search/deep` 强制 Deep；传入冲突 strategy 返回 400，不得被端点静默覆盖。
- `strategy=quality` 单独使用且无 rerank 模型：执行 RRF 并返回 degradation，不得让基础搜索失败。strategy 不重写旧 `SearchMode` 枚举，也不吞掉显式 mode 的模型阶段语义。
- MCP/CLI/Skills 复用同一 Zod schema 和 SearchService；OpenAPI、CLI help、Skill 文档同批更新。

### 6.4 测试落点

`tests/unit/search-intent.test.ts` 覆盖全部 mode×strategy 组合、缺省 mode、等价映射、冲突 400、Deep 端点；`tests/integration/search-contract-compatibility.test.ts` 对 REST/MCP/CLI/Skills 运行同一组请求，断言旧 golden 字段存在且类型不变。

## 7. 可解释规则路由

新增 `packages/core/src/strategy/{router,types}.ts`：

```ts
interface RouteDecision {
  selected: Strategy;
  ruleId: string;
  matchedSignals: string[];
  considered: Array<{
    ruleId: string; matched: boolean; signals: string[];
    providerSnapshots?: Array<{
      providerId: string; priority: number; health: string;
      latencyMs: number | null; quotaRemaining: number | null;
    }>;
  }>;
  decidedAt: string;
}
```

`routeSearch(request, providerSnapshots, config)` 为纯函数，不调模型、不读向量：

1. 显式 strategy 优先，route 标记 `ruleId=explicit_strategy`，自动路由不得覆盖。
2. `auto` 按固定优先级匹配：显式 Deep 意图 → 比较/多约束/研究信号 → 复杂问题 → 短查询/精确 URL 导航 → Balanced。
3. 显式 Provider/group 始终优先于自动 Provider 建议；路由不会替换用户选择。
4. Provider 能力、enabled、Adapter 可用性按 B1 过滤；priority、health、latency、quota 写入 `considered`，用于解释和派发调度，不改变 B1 合并顺序，也不静默移除不健康源。
5. 不因商业 Provider 名称加权；模型可用性仅决定可选阶段/降级，不决定用户意图。
6. 同输入与同配置快照连续 100 次决策完全一致；`decidedAt` 是唯一动态字段。

测试：`tests/unit/search-router.test.ts` 覆盖每条规则、100 次确定性、零模型调用、显式 Provider 优先、健康/配额仅解释不过滤、固定配置回放。

## 8. 查询扩展与多语言

新增 `packages/core/src/query/{normalize,language,expand}.ts`：

- `normalizeQueryIdentity()`：NFKC + casefold + 空白折叠，仅用于去重/身份；展示与发送保留用户原查询。
- `detectQueryLanguage()`：本地确定性识别 zh/en/ja/mixed，不调用模型；无法判断为 `und`。
- `planQueryExpansion()`：默认关闭；仅 Balanced/Quality/Deep、查询达到长度/词数阈值、`queryExpansion !== false`、存在可用 chat 模型时启用。
- 扩展最多 3 个附加查询，加原查询最多 4；按规范化身份确定性去重，保持原查询为 q1。
- 不静默翻译专有名词；扩展结果标记来源 `model|rule`，响应返回实际查询、语言、扩展来源和跳过原因。
- 缓存指纹纳入查询扩展配置、规则/模型版本、实际查询计划；原查询始终参与身份，不得只用扩展查询做键。

测试：`tests/unit/query-expansion.test.ts` 覆盖 zh/en/ja/混合 CJK-拉丁、重复扩展、上限、默认关闭、无模型降级、原查询保留、缓存键随配置变化。

## 9. 统一正文读取与 B5 分类

### 9.1 模块与接口

- `apps/api/src/services/web-read.ts`：`WebReadService.read(input, {signal, actor})`。
- `packages/core/src/web/{fetch,extract,classify}.ts`：HTTP 读取、正文提取、B5 分类。
- `packages/runners/src/{worker,normalize}.ts`：CPU 规范化 worker。
- `POST /api/web/read`；MCP `read_webpage`；CLI `shub read <url>`；Skill 均调用同一服务。

请求 `{url, render?, maxBytes?, timeoutMs?}`；缺省最多 2 MiB、10 秒、5 次重定向。继续复用 SSRF/重定向校验，仅 http(s)，拒绝非文本类型；原始 HTML 不默认返回。普通 HTTP 路径 Chromium 启动次数必须为 0；`render=true` 仅管理员启用时可用。

### 9.2 B5 分类

`readStatus = ok | login_required | captcha | maintenance | not_found | unsupported`；`truncated` 是独立布尔字段。分类优先级：

```text
captcha > login_required > maintenance > not_found > unsupported > ok
```

- soft 404：HTTP 200，title/h1 规范化精确等于 `404 not found`/`page not found`，且正文含等价标记；>200 词且无精确标记的技术文章不得误杀。
- login：password 输入 + 登录表单/路径，或精确登录标题，且正文 <200 词；含 login 链接/密码讨论的长文不得误杀。
- captcha：挑战元素 `cf-chl`/`g-recaptcha`/`hcaptcha`，或精确标题 + 挑战表单；仅关键词的安全文章不得误杀。
- maintenance：HTTP 503，或精确维护标题 + 维护文案/`Retry-After`；维护流程长文不得误杀。

识别不可用返回 `content=null`、稳定 `readStatus` 与 `reasonCode`，不返回 HTML。REST 映射：ok→200；已抓取但不可用→422；上游网络/协议→502；超时→504。超限返回 `truncated=true`。

### 9.3 缓存与 Runner

正文缓存（P1）键含规范化 URL、读取模式、提取器版本；默认 TTL ≤1 小时；不转发 Cookie/Authorization；可绕过/清理。正文规范化在 worker 中执行，失败返回 `runner_unavailable`，不得回退主进程。

测试：`tests/unit/web-read-classify.test.ts` 的 B5 正反例矩阵与优先级；`tests/integration/web-read.test.ts` 的 2 MiB/10s/5 重定向/非文本/错误映射/Chromium 0 次；`tests/unit/web-read-cache.test.ts` 的版本键与 TTL。

## 10. SSE / NDJSON 流式契约（B4）

### 10.1 模块

- `packages/core/src/stream/{events,serialize}.ts`：`StreamEvent`、`StreamSequencer`、`serializeSse()`、`serializeNdjson()`、`normalizeFinalSnapshot()`。
- `apps/api/src/services/search-stream.ts`：订阅 SearchService 的候选/状态事件，管理心跳与慢消费者。
- `apps/api/src/routes/search-routes.ts`：新增 `POST /api/search/stream`，开流前完成校验。

所有入口共享同一执行与最终序列化逻辑。首批 meta ≤1 秒；Provider 返回后即可增量推送；15 秒心跳。无伪进度定时器。

### 10.2 Grammar

```text
meta → (results | status)* → terminal
terminal = done(final:true) | error(terminal:true) | status{status:"cancelled",terminal:true}
```

- 所有数据事件含 `type`、`sequence`、`final`；sequence 从 1 开始，每个非心跳事件严格 +1，无跳号/重用。
- SSE：`event: <type>\ndata: <compact-json>\n\n`；心跳 `: heartbeat\n\n`。
- NDJSON：每行一个 compact JSON；心跳 `{"type":"heartbeat"}`，不占 sequence。
- `results` 必须 `final:false`；`done` 必须 `final:true`，含 `sequence/status/results/summary/stats/errors/failedSources/strategy/route`。
- completed/partial→done；failed→error；cancelled→cancelled status。终态后不得再有数据事件。
- 缓存命中只有 meta(1) 与 done(2)，不得伪造 results。
- 客户端断开立即取消上游；慢消费者超过有界队列（建议 64 事件/1 MiB）主动断开并取消，不能无限缓冲。
- 临时结果不缓存、不入历史、不参与指标。

### 10.3 Golden 与最终快照

提交 SSE/NDJSON 两套 Golden：单源成功、多源部分成功、Quality 重排、Deep 跨查询重复、缓存命中、失败、取消。动态值使用固定占位符，帧结构逐字节比较，JSON 语义规范化后比较。

规范化副本仅移除 `taskId/requestId/sequence/type/final/stream/retrievedAt/timing.*/route.decidedAt`；分数统一 6 位；`stats.providers` 按 providerId、`sources` 按 providerId,rank 排序。**不得排序 results**，不得移除状态、错误、策略、路由规则、分数、候选计数。

测试：`tests/unit/stream-grammar.test.ts`（sequence、心跳、终态、规范化）；`tests/integration/search-stream.test.ts`（真增量、≤1s meta、15s 心跳、断开取消、缓存/错误/取消 golden、流式与非流式一致）。

## 11. SQLite 缓存 v1/v2 兼容与回滚（B6）

### 11.1 指纹

`apps/api/src/services/search-cache-key.ts` 新增 `buildSearchFingerprintV2()`，纳入：

- `cacheFormatVersion=2`；
- 引擎/流水线版本；
- 有效 mode 或 strategy；
- 路由版本；
- 召回参数（limit、perProviderLimit、Provider 集合与能力）；
- 语言、时效、查询扩展配置与实际查询计划；
- 模型阶段版本/非密模型指纹；
- 现有 Provider 非密配置与 credentialVersion。

`CacheService.buildKey()` 继续对 canonical JSON 做 SHA-256，键不含明文查询或密钥。旧 v1 键生成器保留用于兼容读取，新写只写 v2。singleflight 仍复用 `SearchFlightService`。

### 11.2 兼容矩阵

| 旧 mode | v0.1.18 无 strategy 请求可读 v1？ |
|---|---|
| 缺省 basic / 显式 basic | 可，仅有效召回深度、Provider、语言、时效、limit 等全部相同 |
| rrf | 可，仅融合参数、有效召回深度及其余输入全部相同 |
| web / grounded / research | 仅解析后等价于未变更阶段且全部有效输入相同 |
| rerank / embedding / embedding_rerank / rerank_summary | 不可 |
| deep | 不可 |
| 任何显式 strategy | 不可，只能读 v2 |

v1 行按原 version 读取，不删除、不重写；不满足条件为逻辑 miss，原行保留至自然过期/淘汰。v1 命中仍需按当前响应契约补齐新增字段，但不得改变旧 results 顺序。升级迁移只新增可空/带默认列/索引，不删除旧列、旧表、旧缓存行。

### 11.3 索引与回滚

复用 `idx_search_cache_expires`、`idx_search_cache_accessed` 与 `search_cache_state` totals；统计不得随记录数线性扫描。旧二进制忽略不认识的 v2 指纹并正常 miss，不得崩溃或误用。

测试：`tests/unit/cache-migration.test.ts` 与新增 `tests/integration/cache-v1-v2-compat.test.ts`：真实 v0.1.17 SQLite 升级后行数/TTL/内容不变；等价 basic/rrf 命中，其余 miss 且无重复写；回滚旧二进制 miss；显式 strategy 不读 v1。

## 12. 资源预算状态机与隔离 Runner（B7）

### 12.1 模块与信号

- `apps/api/src/services/resource-budget.ts`：`ResourceBudgetController`、`BudgetState`、`ResourceSample`。
- 复用 `runtime-monitor.ts`、`scripts/lib/resource/*`、`resource-doctor.mjs`、`test-lowmem.mjs`，不新增常驻监控 Agent。
- 每 1 秒采样。`P=max(rssRatio,heapRatio,queueRatio,inFlightRatio)`；至少一个有效信号才计算，缺失信号不按 0 计。

### 12.2 状态迁移（B7）

- normal：P<0.75；P≥0.75→warning，P≥0.90→critical。
- warning：P≥0.90→critical；停留满 3 次后，**先判 P≤0.55→recovering，否则 P<0.75→normal**，否则留 warning。
- critical：停留满 3 次且连续 3 次 P≤0.55→recovering；否则停留满 3 次后 P<0.90→warning，否则留 critical。
- recovering：P≥0.75→warning，P≥0.90→critical；否则继续步进。

> 执行顺序澄清：B7 原文 warning 的 `P<0.75` 与 `P≤0.55` 条件重叠，这里采用低阈值优先判定，避免 `P≤0.55` 永远无法进入 recovering。此澄清不改变阈值、次数或预算公式。

### 12.3 预算与硬上限

- normal=`hardMax`；warning=`max(minBudget, floor(0.5×hardMax))`；critical=`minBudget`。
- recovering 从 minBudget 开始，每连续 3 次低压力增加 `ceil((hardMax-minBudget)/4)`，不超过 hardMax，达到后回 normal。
- 并发类向下取整且至少 1（hardMax=minBudget 不变）；Embedding 批次向下取到 8 的倍数且至少 8。
- 管理员调低 hardMax 立即生效；自动状态只能进一步收紧，不能越过手动硬上限。
- 采样失败前 2 次保持上次预算并记 `stale_sample`；连续 3 次失败→critical/minBudget；恢复须重新连续 3 次低压力。
- 控制对象：Agent、Vitest、Playwright、构建、搜索 Provider、Deep 子查询、Embedding 批次、正文提取并发。
- 资源事件只记录预算、实际值、原因、任务类型，不记录查询、网页或凭证。

### 12.4 隔离 Runner

`packages/runners` 使用 `worker_threads` 执行正文规范化、离线评测等 CPU 任务；默认最多 2 Worker，单任务 CPU 超时 5 秒、堆上限 128 MiB、输入/输出字节有界。超限终止 Worker，返回稳定 `runner_unavailable`，不泄露路径/查询/堆栈，不回退主进程。Chromium（P1）独立进程/上下文，并发 1、每页 30 秒，复用相同出站/资源限制，默认不下载浏览器。

测试：`tests/unit/resource-budget.test.ts` 用 fake-clock 覆盖 0.75/0.90/0.55 边界、3 次滞回、步进、采样失败、手动上限；`tests/unit/runner.test.ts` 覆盖超时/堆/输入上限/`runner_unavailable`/无主进程回退；既有 `resource-pressure.test.ts`、`resource-doctor.test.ts` 继续作为进程所有权与真实资源证据。

## 13. B8 真实质量评测协议与证据边界

### 13.1 模块

- `packages/core/src/evaluation/bootstrap.ts`：`pairedStratifiedBootstrap()`、`mulberry32()`、分层抽样。
- `packages/core/src/evaluation/snapshot.ts`：`evaluationSnapshotSchema`、`parseEvaluationSnapshot()`、`snapshotFingerprint()`；v2 保留旧 QuerySnapshot 字段并增加 language/providerFingerprints/modelArtifacts/deepRounds，旧 ProviderSnapshot[] 按 v1 读取。
- `packages/core/src/evaluation/strategy.ts`：`RankStrategy=fusion|embedding|rerank|route|deep`、`compareRankStrategies()`。
- `packages/core/src/evaluation/protocol.ts`：样本完整性、missing、observed/releaseScore、发布门槛。
- `scripts/quality-eval.mjs`：冻结数据集与双实现执行入口。
- `apps/api/src/services/quality.ts` / `routes/quality-routes.ts`：Search Lab snapshot/live、原始证据引用、对比报告。
- `tests/fixtures/v0118-quality/`：人工 qrels、查询集、指纹与预注册文件（不得标记 synthetic 为真实证据）。

### 13.2 数据与公平性

冻结至少 40 条真实公开查询，中英文各 ≥12，覆盖导航、事实、比较、技术、新闻/时效。至少两名人工标注者对基线/候选结果并集 top 20 按 0–3 标注，分歧仲裁；保留 `human` 来源与 qrels 指纹。Recall 仅在标注完整时计算。固定 exact commit、查询集、qrels、top K、去重和公式；development/holdout 不泄漏。

两层证据分开：同快照重排隔离算法变化；真实联网配对验证端到端。两次独立 live 抓取不得包装成同快照。快照中的 `modelArtifacts` 使用非密结构 `Record<'embedding'|'rerank'|'chat', {modelId, configFingerprint, stageVersion}|undefined>`，`providerFingerprints` 为 `Record<providerId,string>`；不得包含 Key、Authorization 或凭证 URL。

### 13.3 Bootstrap（B8）

- `pairedStratifiedBootstrap({pairs, iterations=10000, seed=118, metric})` 接收冻结配对样本；`pairs` 含 language/category/queryId、baseline/candidate QueryMetrics、failure/provisional。返回 observed、releaseScore、delta、ci95、strata、pairedN、excludedN、status。
- 配对 query 级重采样 10,000 次，seed=118，PRNG=mulberry32；全运行只用一个 PRNG 实例。
- 调用顺序：iteration 外层、stratum 内层；层按名称排序，层内 queryId 升序。
- 分层 `language × category`；每层有放回抽取与原层相同数量，同一抽取索引同时应用于 v0.1.17/v0.1.18。
- 先算层均值，再按冻结样本各层 query 数占比加权为总体；2.5/97.5 百分位，不使用 BCa。
- 任一样本层 <4：不合并、不伪造分层 CI，输出 `INSUFFICIENT_EVIDENCE`。

### 13.4 Missing、指标与门槛

- 无人工标注/provisional 不进主样本；一侧失败、预算耗尽或超时整对排除并报告 attrition。
- 有效空结果在展示层保持 N/A，但发布决策 `releaseScore` 的 nDCG/MRR/P 记 0；observed 与 releaseScore 分别报告有效配对数和区间，提升结论须两种口径方向一致。
- 报告 `expectedPairs/pairedN/excludedN` 与逐条原因；attrition>20% 证据不足。未标注文档绝不按 0 填充。
- 主指标 nDCG@10；辅助 MRR@10、P@10、Recall@20（完整标注时）；护栏为空结果率、部分失败率、重复率、P50/P95 延迟、上游请求数。
- 总体有效配对 ≥24、分类 ≥8；holdout 平均 nDCG@10 提升 ≥0.03，配对 bootstrap 95% CI 下界 >0，MRR@10 下降 ≤0.01。
- 预注册分类 nDCG 下降 >0.03、空结果率上升 >1 个百分点或 P95 延迟上升 >20% 必须说明并重新评审。
- 无付费 Key 时结论限定于实际公开/自托管源；报告列出改善/退化/失败查询、未标注比例、实际 Provider 与所有降级。

### 13.5 Live 配对

冻结查询顺序、Provider 集合、非密配置指纹；同实例/区域、缓存关闭、单查询串行、AB/BA 交替、时间窗 ≤24 小时。每查询最多 2 次尝试，仅网络/5xx/429 可重试并遵守 `Retry-After`；鉴权/配额失败不重试。每对保存原始 per-provider 快照及哈希、实际请求数、延迟、错误、退化原因。snapshot 与 live 分开统计，禁止合并 bootstrap；未执行查询不得补造分数。

测试：`tests/unit/quality-bootstrap.test.ts` 固定 seed/调用顺序/分层/CI；`tests/unit/quality-protocol.test.ts` 覆盖 missing、attrition、releaseScore、层不足；`tests/integration/quality-lab.test.ts` 覆盖 snapshot/live 分离、证据指纹、预算与取消。CI 只跑 offline，live 作为单独发布证据。

## 14. 分阶段实施顺序与文件清单

### 阶段 0：冻结契约与红测

- 冻结 PRD B1–B8；为五类 Bug、状态机、预算、SSE grammar、缓存矩阵建立失败红测。
- 文件：`docs/v0118-prd.md`、`docs/v0118-architecture.md`、`tests/unit/search-engine-recall.test.ts`、`tests/unit/search-service-cancellation.test.ts`、`tests/integration/search-service-quality.test.ts`。

### 阶段 1：共享契约与候选池

- 先改 schema/types，再实现 Provider 选择、400 轮询、去重、200 rankingInput、funnel；解除模型阶段提前截断。
- 文件：`packages/shared/src/{schemas,types}.ts`、`packages/core/src/engine/{provider-selection,candidate-pool,search-engine}.ts`、`packages/core/src/fusion/fuse.ts`。

### 阶段 2：取消、模型批次与任务状态

- 统一 AbortContext/deadline，模型接口传 signal，任务终态条件提交；禁止取消写缓存。
- 文件：`packages/core/src/engine/cancellation.ts`、`packages/models/src/{embeddings,rerank,chat}.ts`、`apps/api/src/services/{search,search-task-state}.ts`。

### 阶段 3：策略、路由、扩展与 Deep

- 实现 intent 解析、四策略、规则路由、查询扩展；Deep 改用预算与 B3 融合。
- 文件：`packages/core/src/strategy/*`、`packages/core/src/query/*`、`packages/core/src/deep/*`、`packages/shared/src/{schemas,types}.ts`。

### 阶段 4：统一正文与 Runner

- 实现 HTTP 正文读取/B5 分类、worker 隔离、可选正文缓存；默认不启动 Chromium。
- 文件：`apps/api/src/services/web-read.ts`、`packages/core/src/web/*`、`packages/runners/src/*`、`apps/api/src/routes/web-routes.ts`。

### 阶段 5：流式与入口一致性

- 实现事件 grammar/sequencer、SSE/NDJSON、心跳/慢消费者断开；REST/MCP/CLI/Skills 共用最终快照。
- 文件：`packages/core/src/stream/*`、`apps/api/src/services/search-stream.ts`、`apps/api/src/routes/search-routes.ts`、`packages/mcp/src/{tools,server}.ts`、`packages/cli/src/commands/{search,read}.ts`、`packages/skills/*`。

### 阶段 6：缓存 v2 与资源治理

- 新指纹写 v2、v1 兼容读、迁移/回滚测试；资源预算状态机接入搜索/Deep/Embedding/正文。
- 文件：`apps/api/src/services/{search-cache-key,cache,resource-budget}.ts`、`packages/db/src/{schema,migrate}.ts`、新增 `packages/db/migrations/*v0118*`、`apps/api/src/services/settings.ts`。

### 阶段 7：Lab、真实评测与发布证据

- Search Lab snapshot/live、B8 bootstrap、40 查询人工 qrels、双实现 exact-SHA 对比；全量回归与发布门禁。
- 文件：`packages/core/src/evaluation/{bootstrap,protocol}.ts`、`scripts/quality-eval.mjs`、`apps/api/src/{services/quality,routes/quality-routes}.ts`、`tests/fixtures/v0118-quality/*`、`docs/v0118-quality-report.{md,json}`。

### 关键测试清单

| 契约 | 测试 |
|---|---|
| B1 | `candidate-pool.test.ts`、`search-engine-recall.test.ts`、`fusion.test.ts`、`search-service-quality.test.ts` |
| B2 | `search-task-state.test.ts`、`search-service-cancellation.test.ts`、`search-stream.test.ts` |
| B3 | `deep-fusion.test.ts`、`deep-budget.test.ts`、`search-service-quality.test.ts` |
| B4 | `stream-grammar.test.ts`、`search-stream.test.ts`、`tests/fixtures/v0118-stream/*` |
| B5 | `web-read-classify.test.ts`、`web-read.test.ts` |
| B6 | `cache-migration.test.ts`、`cache-v1-v2-compat.test.ts` |
| B7 | `resource-budget.test.ts`、`runner.test.ts`、既有 resource 测试 |
| B8 | `quality-bootstrap.test.ts`、`quality-protocol.test.ts`、`quality-lab.test.ts`、真实质量报告 |

## 15. 交付与验收门禁

- P0 全部有红测/绿测；候选池、Deep、取消、流式、缓存、资源上限均有边界与压力测试。
- `typecheck`、`lint`、全量测试、构建、既有发布门禁通过；无新增高危依赖或密钥泄漏。
- API/MCP/CLI/Skills/缓存/质量文档同步；CHANGELOG 明示兼容性变化。
- 真实质量达到 §7 门槛，或明确 `INSUFFICIENT_EVIDENCE`/部分来源验证；不得以 synthetic fixture 宣称提升。
- 回滚不删除新字段或缓存行；旧版本可打开升级后的 SQLite；旧入口保持可用。
