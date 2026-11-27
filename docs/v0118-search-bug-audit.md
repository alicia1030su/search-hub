# v0.1.18 搜索核心 Bug 审计与红测

- 审计基线：`ea0a35dea23517584b29995fcaae4d5b7fdaf8f6`
- 工作树：`C:/Users/TYMO001/WorkBuddy/search-hub-v0118`
- 分支：`feat/v0118-search-core`
- 审计日期：2026-11-28
- 资源：审计前可用物理内存 `6242 MiB`；未运行重型构建，Vitest 使用 `--maxWorkers=2 --no-file-parallelism`。
- 网络：全部使用内存 fake adapter / fake model，无真实网络、无付费 API。

## 总结

| 编号 | 问题 | 是否可复现 | 严重级别 | 红测文件 |
|---|---|---:|---:|---|
| S1 | Embedding/Rerank 前按 `request.limit` 过早截断 | 是 | 高 | `tests/integration/search-service-quality.test.ts` |
| S2 | Embedding/Rerank 忽略取消信号 | 是 | 高 | `tests/unit/search-service-cancellation.test.ts` |
| S3 | Deep Search 跨子查询未按规范化 URL 去重 | 是 | 高 | `tests/integration/search-service-quality.test.ts` |
| S4 | Deep Search 直接累加归一化分数导致排序偏差 | 是 | 中 | `tests/integration/search-service-quality.test.ts` |
| S5 | 单 Provider `limit=100` 被 `perProviderLimit=50` 硬截断 | 是 | 高 | `tests/unit/search-engine-recall.test.ts` |
| S3b | 同域相似标题不同正文被近标题去重误合并 | 是 | 中 | `tests/unit/search-engine-recall.test.ts` |

## 执行命令与原始证据

组合红测命令：

```bash
pnpm exec vitest run \
  tests/unit/search-engine-recall.test.ts \
  tests/unit/search-service-cancellation.test.ts \
  tests/integration/search-service-quality.test.ts \
  --maxWorkers=2 --no-file-parallelism
```

结果：

- Exit code：`1`
- Test Files：`3 failed (3)`
- Tests：`7 failed (7)`
- 日志：`artifacts/v0.1.18/qa-repros/search-core-redtests.log`
- 退出码：`artifacts/v0.1.18/qa-repros/search-core-redtests.exitcode`
- 基线 SHA：`artifacts/v0.1.18/qa-repros/search-core-redtests.head`

七个失败均为产品行为与合理契约不符，不是测试 fixture 错误。

---

## S1：Embedding/Rerank 前按 `request.limit` 过早截断

### 复现

`tests/integration/search-service-quality.test.ts`：

- 单 Provider 返回 13 个候选（默认 `perProviderLimit = limit + 3`）。
- 第 11 个候选具有最高 embedding 相似度。
- 请求 `limit=10`、`mode="embedding"`。
- 期望第 11 个候选进入重排并成为第一名。

失败证据：

```text
expected 'https://example.com/1' to be 'https://example.com/11'
```

### 根因

- `packages/core/src/engine/search-engine.ts:177-179` 在融合阶段直接 `fused.slice(0, limit)`。
- `apps/api/src/services/search.ts:389-394` 在 `executeSearch` 返回后才执行 Embedding/Rerank。
- 因此模型阶段永远只能看到已经截断的 `request.limit` 条，初始排名第 11 位但语义最相关的文档无法进入候选集。

### 建议回归测试

保留 `tests/integration/search-service-quality.test.ts` 中：

```text
reranks the full candidate set instead of only the pre-truncated request.limit
```

### 修复方向

将“召回候选数”和“最终返回数”分离；Embedding/Rerank 使用独立候选池，最终返回前再按 `request.limit` 截断。

---

## S2：Embedding/Rerank 忽略取消信号

### 复现

`tests/unit/search-service-cancellation.test.ts`：

- 调用 `applyEmbedding` / `applyRerank` 时传入已经 aborted 的 `AbortSignal`。
- 期望 fake embedding / rerank 客户端不被调用。

失败证据：

```text
expected "vi.fn()" to not be called at all, but actually been called 1 times
```

两个模型客户端均被调用一次。

### 根因

- `apps/api/src/services/search.ts:941-954` 的 `applyEmbedding` 参数名为 `_signal`，未使用。
- `apps/api/src/services/search.ts:969-984` 的 `applyRerank` 同样忽略 `_signal`。
- `packages/models/src/embeddings.ts:9-12` 的 `EmbeddingModel.embed` 与 `packages/models/src/rerank.ts:15-18` 的 `RerankModel.rerank` 接口本身没有 `signal` 参数，模型客户端无法传播取消。

### 建议回归测试

保留：

```text
does not invoke the embedding client after cancellation
does not invoke the rerank client after cancellation
```

后续应补充“模型调用开始后 abort，客户端立即停止且不写入永久失败状态”的测试。

### 修复方向

为模型客户端接口增加可选 `AbortSignal`，在 stage 开始前检查 `signal.aborted`，并把 signal 一路传到 HTTP fetch。

---

## S3：Deep Search 跨子查询未按规范化 URL 去重

### 复现

`tests/integration/search-service-quality.test.ts`：

- 子查询 `q1` 返回 `https://example.com/article?a=1&utm_source=first`。
- 子查询 `q2` 返回 `https://example.com/article?utm_source=second&a=1`。
- 两个 URL 经 `normalizeUrl` 后相同，但 Deep Search 返回 2 条。

失败证据：

```text
expected [ { …(12) }, { …(12) } ] to have a length of 1 but got 2
```

### 根因

- `apps/api/src/services/search.ts:869-887` 使用 `new Map<string, SearchResult>()`，key 为原始 `result.url`。
- 每个子搜索内部会调用 `dedupeResults`，但 Deep Search 合并阶段不再使用规范化 URL，导致跟踪参数、参数顺序、跨子查询/跨 Provider 的变体漏去重。

### 子场景判定

| 子场景 | 判定 |
|---|---|
| 跟踪参数跨子查询 | 可复现 |
| 参数顺序跨子查询 | 可复现 |
| 跨 Provider 且跨子查询 | 可复现 |
| 跨 Provider 同一子查询 | 不可复现；核心 `dedupeResults` 已处理 |
| 多子查询同一文档 | 可复现 |

### 建议回归测试

保留：

```text
deep-merges tracking-parameter variants across subqueries and providers by normalized URL
```

### 修复方向

Deep Search 合并 key 改为 `normalizeUrl(result.url) ?? result.url`，或直接使用 `result.id`（当前核心响应已把规范化 URL 写入 `id`），并合并 sources。

---

## S3b：同域相似标题不同正文被误合并

### 复现

`tests/unit/search-engine-recall.test.ts`：

- 两个不同 URL：`/docs/api` 与 `/guides/api`。
- 标题完全相同：`OpenAI API Documentation Guide`。
- snippet 明确不同：API reference vs migration guide。
- 期望保留 2 条，实际只剩 1 条。

失败证据：

```text
expected [ { …(12) } ] to have a length of 2 but got 1
```

### 根因

- `packages/core/src/fusion/fuse.ts:97-125` 在同域标题 token Jaccard 超过阈值时直接按 `near_title` 合并。
- 当前实现没有正文/片段差异校验，相同标题但不同内容页面会丢失。

### 建议回归测试

保留：

```text
does not collapse same-title pages with different URLs and bodies
```

### 修复方向

近标题去重至少要求 snippet/正文相似度也达到阈值，或仅在高相似标题且 URL 路径也相似时合并。

---

## S4：Deep Search 归一化分数直接累加导致排序偏差

### 复现

`tests/integration/search-service-quality.test.ts`：

- 子查询 `weak`：仅 1 个 Provider 返回 `weak`，该子查询内归一化分数为 `1.0`。
- 子查询 `strong`：3 个 Provider 一致返回 `strong`，该子查询内归一化分数也为 `1.0`。
- Deep Search 直接相加后两者同为 `1.0`；稳定排序保留先插入的 `weak`。
- 期望跨查询共识更强、原始 RRF 总分更高的 `strong` 排第一。

失败证据：

```text
expected 'https://example.com/weak' to be 'https://example.com/strong'
```

### 根因

- `packages/core/src/engine/search-engine.ts:176-196` 每个子查询独立把分数归一化到 `[0,1]`。
- `apps/api/src/services/search.ts:883-893` 直接累加这些已归一化分数并按总和排序。
- 归一化抹平了子查询之间的 Provider 共识强度，使“单源子查询第一名”与“三源共识第一名”等权。

### 建议回归测试

保留：

```text
does not let a weak single-source subquery outrank a strong multi-source consensus after score normalization
```

### 修复方向

Deep Search 使用跨查询 RRF/排序位置融合，或保留未归一化 fusion score 后再做跨查询比较；不要直接累加各子查询独立归一化分数。

---

## S5：单 Provider `limit=100` 被 `perProviderLimit=50` 硬截断

### 复现

`tests/unit/search-engine-recall.test.ts`：

- 单 Provider，请求 `limit=100`。
- fake adapter 返回 `input.limit` 条候选。
- 期望 100 条，实际 50 条。

失败证据：

```text
expected [ { …(12) }, { …(12) }, …(48) ] to have a length of 100 but got 50
```

### 根因

- `packages/core/src/engine/search-engine.ts:68-71` 将 `perProviderLimit` 硬上限设为 50。
- 单 Provider 时默认公式本应给出 100，但被 cap 到 50。
- `packages/core/src/engine/search-engine.ts:177-179` 再按 `request.limit` 截断，无法恢复已丢失召回。

### 建议回归测试

保留：

```text
does not cap a single-provider limit=100 request to 50 candidates
```

### 修复方向

将 Provider 候选上限与全局返回上限解耦；单 Provider 请求应允许至少 `request.limit` 的候选，多 Provider 时按总召回预算分配。

---

## 优先级建议

1. 先修 S1/S5：否则 Embedding/Rerank 和高 limit 请求在模型看到候选之前就已经丢失召回。
2. 修 S2：取消必须贯穿模型 HTTP 调用，避免用户取消后继续付费/占坑。
3. 修 S3/S3b：Deep Search 与核心去重必须使用规范化身份和内容相似度，避免重复与误合并。
4. 修 S4：跨查询融合应基于可比较的原始分数或查询级 RRF，而不是独立归一化分数相加。
