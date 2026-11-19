# v0.1.10 Stable 增量 PRD — 搜索源一键体检中心

## 0. 项目信息

| 项 | 值 |
|---|---|
| Language | 中文（UI 文案中英同批交付） |
| Programming Language | 沿用现有栈：Node 22 + Fastify + Drizzle/SQLite；Vite + React + MUI + Tailwind；Vitest + Playwright |
| Project Name | `provider_bulk_health_check` |
| 版本 | v0.1.10（Stable；基线 v0.1.9，已发 v0.1.10-beta.1 / -beta.2） |
| 迁移 | `0008_provider_test_batches` |
| 基线 commit | `63dc2ed`（main） |
| 原始需求复述 | 把「逐个点测试按钮」升级为「一次预检 + 一次批量执行 + 一张可解释的结果表」，并消除 `POST /providers/:id/test` 与 `HealthService.checkOne` 两套探测实现的差异——后者已复现：`testProvider` 未传 `search: resolveSearchConfig(...)`，走适配器 `if (!search)` 单页兜底，只发 1 个请求，探测的不是生产分页链路。 |

## 1. 目标与非目标

**一句话目标**：管理员在来源页点一次「全部测试」，先看到「哪些能测、哪些被跳过、大概花多少额度」，确认后看到可取消的实时进度与按严重度排序、可解释到具体错误分类的结果，且单源测试与批量探测走同一条生产链路。

本轮不做（硬约束）：
1. 不新增任何厂商探测或质量基准；**不得**把 Synthetic/stub 结果描述为真实厂商质量。
2. 不改搜索主链路、排序、缓存、结果去重。
3. 不改预算、冷却、退避算法（`ProbeBudget` / `decideBudget` / `cooldownFor` 保持现状）。
4. 不提供任何「强制突破预算 / 跳过冷却」入口（无 override、无 `skipCooldown`、无提额按钮）。
5. 不建第二套健康事实表，不重写 `provider_health_checks` 历史行。
6. 不做跨实例 / 分布式队列；执行在单进程内，进度靠 DB 记录。
7. 不做定时巡检的 UI 改版（`scheduledEnabled` 等仅复用现有设置项）。
8. 不做 WebSocket / SSE，进度用轮询。
9. 不展示 Key 明文、不做导出。
10. 不改 6 个分页适配器的 `if (!search)` 兜底分支（保留兜底，只保证探测传入 `search`）。
11. 不做历史趋势图（沿用现有健康面板）。
12. 不引入 Redis 或外部任务队列。

## 2. 用户故事

- **US1** 作为管理员，我想在真正发请求前看到「可测 12 / 无 Key 5 / 禁用 3 / 剩余预算 8」，这样我不会因为误点「全部测试」而消耗第三方额度。
- **US2** 作为管理员，我想在批量执行时看到实时进度与「部分完成」，并能取消，取消后已完成的结论仍然可读。
- **US3** 作为管理员，我想让失败排在最前，并能「只重测失败项」，这样我不用再扫一遍全表。
- **US4** 作为管理员，我想在详情里看到错误分类、耗时、结果数、上游请求数、最多 3 条样例和脱敏 Key 标签，这样我能直接判断该改 Key、改配置还是等冷却。
- **US5** 作为管理员，我想让免 Key 来源默认被跳过并明确标注「未检测」，这样我不会把它误读成「失败」。
- **US6** 作为管理员，我想让单源测试的结论与定时巡检一致，这样同一个来源不会出现两套说法。
- **US7** 作为排障者，我想看到 401 / 403 / 429 / 额度耗尽的具体分类与可重试时间，这样我能一次定位。

## 3. 已定稿决策（D1–D8）

| # | 口径 | 为什么 |
|---|---|---|
| D1 | `POST /api/admin/providers/:id/test` 收敛为 `HealthService.checkOne` 的薄封装（`kind` 显式传入，默认 `search`），删除 `testProvider` 内自拼 `ProviderConfig` 的实现 | 该处未传 `search: resolveSearchConfig(...)`，已复现只发 1 个请求、返回 3 条，与 `checkOne` 结论不一致；两套实现必然再次漂移 |
| D2 | 资格判定顺序：`已禁用 > 无适配器 > 冷却/额度 > Key 状态 > 免 Key 策略` | 从「最绝对、最便宜、不可协商」判到「可配置偏好」：禁用无适配器的来源永远不可测，先排除；冷却/额度是外部瞬时态，不能被误记成 Key 问题；免 Key 策略是运营偏好，放最后以免掩盖更具体的原因 |
| D3 | 分类存储层沿用既有 `HealthCause` 枚举，**不新增枚举值**；对外 API/UI 暴露规格要求的 12 个规范名，经一张固定映射表转换（`dns→dns_error`、`tls→tls_error`、`network→network_error`、`bad_response→invalid_response`、`config_incomplete→configuration_error`，其余同名） | 新增枚举要重写历史行与既有断言；映射表零迁移、零回归 |
| D4 | `empty_results` 单列「待确认」桶：计入已完成、不计入成功率分子、不计入失败 | HTTP 200 但 0 条既不等于「接口可用」也不等于「接口坏了」，混进任何一边都会误导 |
| D5 | `configuration_error`（Key 解密失败、必填配置缺失）计入**失败**，但不计入「上游可用性」质量口径 | 它可修复、必须出现在「只重测失败项」里；同时它不是厂商的问题 |
| D6 | 批量维度用 1 张 `provider_test_batches` + `provider_health_checks.batch_id`，逐源明细仍只存 `provider_health_checks` | 健康事实只有一个来源；任务台账只回答「这次跑到哪了」 |
| D7 | `requests`（上游请求数）由探测链路回填；适配器未上报时为 `null`，UI 显示「—」，**禁止推算** | 探测链路刚修的就是「请求数不对」；用计划页数推算等于把缺陷重新写进 UI |
| D8 | 批量并发默认 2、上限 4（复用 `health.concurrency` 的 1..4 上限），同 Provider 同一时刻只允许一个探测 | 默认 2 是「比串行明显快、又不像扫描」的折中；付费探测重复执行就是重复付费 |

## 4. P0 需求池

| ID | 需求 | 规格条目 | 可测量验收 | 测试 |
|---|---|---|---|---|
| P1 | 单源测试收敛：`testProvider` 改为调用 `checkOne(id,{kind,keyId,trigger:"manual"})`，删除自拼 config；返回体保留 `ok/latencyMs/resultCount/message/sample`，新增 `cause/errorCode/requests/status/checkedAt/keyId` | D1、§8.1 | brave 形态 stub + `searchConfig{targetResults:50,maxPages:3}`：`:id/test` 发出 ≥2 个上游请求，`resultCount` 与同一 stub 的 `checkOne` 相等；全仓仅 1 处构造 `ProviderConfig` 用于探测 | T01–T04 |
| P2 | 资格预检端点，返回 7 个计数 + 预算快照 + 是否可能产生第三方费用 | §5、§8.2 | 构造 20 源（12 可测 / 5 无 Key / 3 禁用）返回 `eligible=12,noKey+noEnabledKey=5,disabled=3` 且 `paidRisk` 与 `kind` 一致 | T05–T09 |
| P3 | 批量任务三端点：创建 / 查进度 / 取消；重启后未完成任务标 `interrupted`，**永不**报 `completed` | §8.3、§10 | 创建返回 `jobId`；进度单调不减；取消后 `status=cancelled` 且已完成条目仍可读；kill 后重启 `GET` 返回 `interrupted` | T10–T15 |
| P4 | 批量执行：并发默认 2 上限 4、同源去重、预算不足标 `SKIPPED_BUDGET`、不自动提额 | D8、§7 | 并发注入 20 源，任意时刻在途探测 ≤2；同源二次创建时被跳过而非重复请求；预算耗尽后剩余条目全为 `skipped/budget` | T16–T19 |
| P5 | 分类与统计口径：12 分类、跳过不计分母、部分完成不显示全部完成 | §6、§7 | 20/12/5/3 场景显示「待检测 12」「跳过 8」，成功率分母 12；`empty_results` 计入待确认且不进分子 | T20–T24 |
| P6 | UI：预检确认框、实时进度、结果表（排序/筛选/只重测失败）、详情抽屉、中英同批 | §9 | Playwright 走完「预检→确认→进度→筛选失败→重测失败→开抽屉」；`zh-CN` 与 `en` 两份文案键集合相等，无硬编码中文 | T25–T30 |

## 5. 资格判定矩阵

判定自上而下，命中即停（顺序即 D2 的优先级）。

| 序 | 条件 | 代码 | 入队 | 计入分母 | 说明 |
|---|---|---|---|---|---|
| 1 | `enabled=false` | `SKIPPED_DISABLED` | 否 | 否 | 禁用是运营明确决定，探测它没有意义 |
| 2 | `getAdapter(type)` 为空 | `CONFIG_ERROR` | 否 | 是（失败） | 类型未实现是配置事故，要出现在失败列表里被修掉 |
| 3 | 冷却中 / 额度已耗尽（`nextProbeAt` 未到、`remainingToday<=0`、`remainingRun<=0`） | `SKIPPED_COOLDOWN` / `SKIPPED_BUDGET` | 否 | 否 | 遵守现有保护；只解释原因，**不新增强制突破** |
| 4 | `adapter.requiresKey` 且解密失败 | `CONFIG_ERROR` | 否 | 是（失败） | 不得当作「不存在」，不得泄漏任何解密内容或密文片段 |
| 5 | `requiresKey` 且一条 Key 都没填 | `SKIPPED_NO_KEY` | 否 | 否 | 无法判断，不是坏 |
| 6 | `requiresKey` 且 Key 全部禁用 | `SKIPPED_NO_ENABLED_KEY` | 否 | 否 | 与 5 区分：用户以为有 Key，实际被关掉了 |
| 7 | `!requiresKey` 且未开启「包含免 Key 来源」 | `SKIPPED_KEYLESS_BY_POLICY` | 否 | 否 | 复用既有 `includeUnverified`；开启后入队，计费归 `search_anonymous` 桶 |
| 8 | 以上都不命中 | `ELIGIBLE` | 是 | 是 | 真正会发请求的集合 |

补充：第 3 条在 `kind=connect` 时只看冷却，不看付费额度（连接探测不消耗付费额度）。
第 4–6 条只对 `requiresKey` 生效；免 Key 来源在任何 Key 状态下都不因 Key 被拦。

## 6. 错误分类

| 规范分类（对外） | 内部 `HealthCause` | 触发条件 | 用户可见文案要点 | 算失败 |
|---|---|---|---|---|
| `auth_invalid` | 同名 | HTTP 401 或 `error.code=auth_invalid` | 「Key 无效或已过期」+ 跳转 Key 管理 | 是 |
| `forbidden` | 同名 | HTTP 403 或 `error.code=blocked` | 「被上游拒绝（403），多为地区/IP/权限限制」 | 是 |
| `rate_limited` | 同名 | HTTP 429 或 `error.code=rate_limited` | 「触发限流」，有 `retryAfterMs` 时给「约 N 秒后重试」 | 是 |
| `quota_exceeded` | 同名 | 401/402/429 正文含 quota/balance/credit/billing/insufficient/exhausted 且不含 rate limit | 「账户额度或余额不足，需人工处理」 | 是 |
| `timeout` | 同名 | `AbortController` 触发（connect 12s / search 20s / `row.timeoutMs` 取小）或 ETIMEDOUT | 「超时：{ms}ms 内未返回」 | 是 |
| `dns_error` | `dns` | getaddrinfo / ENOTFOUND / EAI_AGAIN | 「域名解析失败，检查 Base URL」 | 是 |
| `tls_error` | `tls` | certificate / self signed / tls / ssl | 「证书校验失败，不自动重试」 | 是 |
| `network_error` | `network` | 其余 socket/连接错误 | 「网络不可达」 | 是 |
| `invalid_response` | `bad_response` | HTTP 200 但解析失败、缺必填字段、类型不符 | 「返回结构不符合预期（接口可能已改版）」 | 是（**不算成功**） |
| `empty_results` | `empty_results` | HTTP 200 且结果 0 条 | 「接口通了但无结果，待确认」 | 待确认（计入已完成，不进分子） |
| `configuration_error` | `config_incomplete` | Key 解密失败、必填配置缺失、适配器未实现 | 「配置不完整」，**不展示任何密文/明文** | 是 |
| `cancelled` | 同名 | 用户取消或关机中断 | 「已取消，未写入结论」 | 否（不写健康行） |
| `server_error` | 同名 | HTTP 5xx | 「上游 5xx」 | 是 |
| `no_credential` | 同名 | 无启用 Key（仅单源入口会出现） | 「未验证：没有可用 Key」 | 否（`unverified`） |

缺口说明：现有 `classifyError` 已覆盖上述除「HTTP 状态兜底」外的全部路径；若上游返回 401/403/429 但未落到 `error.code`，需在 `classifyError` 内按 `status` 兜底（P0 子项，不新增枚举）。

## 7. 统计口径

- `total`：本次范围（全部来源或勾选集合）的来源总数。
- `skipped`：命中 §5 第 1/3/5/6/7 条的来源数，**不进分母、不计失败**。
- `testable`（待检测）= `total - skipped`，含 `CONFIG_ERROR`（它在预检阶段即判失败，但确实被检测过）。
- `done` = `ok + failed + pending`（`pending` = `empty_results`）。
- 成功率 = `ok / testable`，分母**只算实际完成检测**的来源。
- 示例（写死，测试按此断言）：20 源 / 12 可测 / 5 无 Key / 3 禁用 → 显示「待检测 12」「跳过 8」，成功率分母 12。
- 部分完成定义：`status=running` 且 `done + skipped < total`，或 `status=interrupted` / `cancelled` 且存在未完成条目 → 一律显示「部分完成（{done+skipped}/{total}）」，**不得**显示「全部完成」。
- 全量完成 = `status=completed` 且 `done + skipped === total` 且无 `unknown` 条目。
- 取消：剩余条目记 `SKIPPED_CANCELLED`，`status=cancelled`，不记为失败。

## 8. API 契约

### 8.1 单源测试（改造，向后兼容）
`POST /api/admin/providers/:id/test` → 体 `{ kind?, keyId?, trigger? }`（均可选，默认 `kind=search`）
```json
{ "ok": true, "latencyMs": 412, "resultCount": 3, "message": "3 result(s) in 412ms",
  "sample": [{ "title": "...", "url": "..." }],
  "status": "healthy", "cause": "ok", "errorCode": null, "requests": 2,
  "kind": "search", "keyId": "key_...", "checkedAt": "2026-...Z" }
```
兼容性：原 5 个字段名/类型完全不变，只增不改；`sample` 仍最多 3 条。
错误映射：预算关闭/耗尽 → 409 `validation_error` / 429 `quota_exceeded`（与 `checkOne` 抛出的语义一致，不再 500）；`cancelled` → 409 `cancelled`。

### 8.2 预检
`GET /api/admin/provider-health/batch-test/preview?kind=search|connect[&group=]`
```json
{ "kind": "search", "total": 20,
  "counts": { "eligible": 12, "noKey": 3, "noEnabledKey": 2, "configError": 0,
              "disabled": 3, "keylessSkipped": 0, "coolingSkipped": 0 },
  "budget": { "paidProbesEnabled": true, "remainingToday": 8, "remainingRun": 8,
              "maxPerDay": 100, "maxRequestsPerRun": 10 },
  "paidRisk": true, "estimatedPaidProbes": 12 }
```
`paidRisk = kind==="search" && counts.eligible>0 && budget.paidProbesEnabled`。预算单位是「探测次数」，1 次探测 1 次预留（内部多页请求不额外计预留）。

### 8.3 批量任务
- `POST /api/admin/provider-health/batch-test` → `{ "jobId": "...", "status": "running", "total": 20, "concurrency": 2 }`
  体：`{ kind, providerIds?: string[]|null, concurrency?: 1..4 }`；`providerIds` 缺省 = 全部启用来源。
- `GET /api/admin/provider-health/batch-test/:jobId` →
  `{ jobId, status: "running"|"completed"|"partial"|"cancelled"|"interrupted",
     counts: { total, done, ok, failed, pending, skipped, remaining },
     items: [{ providerId, providerName, state: "ok"|"failed"|"pending"|"skipped"|"unknown",
               code: "auth_invalid"|"SKIPPED_NO_KEY"|..., latencyMs, resultCount, requests, checkId, reason }],
     budget, startedAt, finishedAt, nextPollAfterMs }`
- `POST /api/admin/provider-health/batch-test/:jobId/cancel` → `{ jobId, status: "cancelled", skippedRemaining }`
- 权限：三个端点全部复用 `/api/admin/*` 现有管理员鉴权与 CSRF 机制（与 `/api/admin/health/check` 同一条链路），不新增鉴权方案。
- 契约硬要求：部分结果可读（运行中即可读已完成条目）；可取消；重启后未完成任务只能 `interrupted`，**永不** `completed`；同源同刻只探测一次；`skipped.reason` 一律为字符串。

## 9. UI 变更点

页面：`apps/web/src/pages/providers/index.tsx` + 新组件 `provider-batch-test-*`，健康面板 `provider-health-panel.tsx` 顶部按钮改为入口。

1. **顶部「全部测试」**：替换现有 `onCheckAll("connect")` / `onCheckAll("search")` 的两个直接执行按钮，改为打开预检确认框。
2. **预检确认框**：6 行数量（可测 / 无 Key（展开显示「未填」「全部禁用」）/ 配置错误 / 已禁用 / 免 Key 跳过 / 冷却中）+ 预算（今日剩余、本轮上限）+ 是否可能产生第三方费用（`paidRisk` 时醒目提示）+ 「开始检测 / 取消」。免 Key 开关在此处切换「包含免 Key 来源」。
3. **实时进度**：进度条 +「{done}/{testable}」+ 当前来源名 + 取消按钮；轮询 `nextPollAfterMs`；`running` 且未跑完显示「进行中」而非「全部完成」。
4. **结果表**：列 = 来源 / 状态 / 分类 / 耗时 / 结果数 / 上游请求数；筛选（全部 / 失败 / 受限 / 待确认 / 成功 / 跳过）；排序固定 失败→受限→待确认→成功→跳过（同档按耗时降序）；「只重测失败项」用失败集合再次 `POST batch-test`。
5. **详情抽屉**：脱敏 Key 标签（如 `key_ab…9f`）、检测时间、耗时、结果数、上游请求数（缺失显示「—」）、错误分类中英文标签 + 建议动作、最多 3 条样例（title + url，纯文本，不渲染 HTML）、「重测这一项」。
6. **中英同批**：所有新增键进 `zh-CN` 与 `en` 两份字典，键集合必须相等；禁止硬编码中文。

## 10. 数据与迁移（`0008_provider_test_batches`）

只做两件事，**不建第二套健康表**：
1. `provider_health_checks` 增 `batch_id text NULL` + `index idx_health_batch (batch_id)`；历史行全为 `NULL`，无需回填。
2. 新表 `provider_test_batches`：`id` PK、`kind`、`status`（`running|completed|partial|cancelled|interrupted`）、`total`、`done`、`ok_count`、`failed_count`、`pending_count`、`skipped_count`、`concurrency`、`options_json`、`items_json`（逐源状态累积，含 skip 与原因）、`budget_json`（起始快照）、`created_by`、`created_at`、`started_at`、`finished_at`。
3. 启动钩子：把所有 `status='running'` 的行改为 `interrupted` 并写 `finished_at`（幂等，单条 `UPDATE`），之后才接受新任务。
4. 不新增 `requests` 列：上游请求数写进 `provider_health_checks.detail_json`（`{"requests": n}`），避免再动主表。

## 11. 测试清单与需求映射

| 测试 | 覆盖点 | 需求 |
|---|---|---|
| T01 | `:id/test` 不再自拼 config，只调用 `checkOne` | P1 |
| T02 | brave 形态 stub + `searchConfig{targetResults:50,maxPages:3}` → `:id/test` 上游请求 ≥2 | P1 |
| T03 | 同 stub 下 `:id/test` 与 `checkOne` 的 `resultCount`/`cause` 相等 | P1 |
| T04 | 返回体含原 5 字段 + 新增 5 字段，且不含任何 Key 明文 | P1 |
| T05 | 预检 7 计数与 20/12/5/3 场景一致 | P2 |
| T06 | `kind=connect` 时不计付费额度，`paidRisk=false` | P2 |
| T07 | `paidProbesEnabled=false` 时 `paidRisk=false` 且创建任务被拒（409） | P2 |
| T08 | 预检不产生任何 `provider_health_checks` 行 | P2 |
| T09 | 布尔/边界：`counts` 之和等于 `total` | P2 |
| T10 | 创建返回 `jobId`，`status=running` | P3 |
| T11 | 运行中 `GET` 可读到已完成条目（部分结果可读） | P3 |
| T12 | 计数单调不减，`done+skipped<=total` | P3 |
| T13 | 取消后 `status=cancelled`，已完成条目保留 | P3 |
| T14 | 重启后 `status=interrupted`，响应的 `status` 不等于 `completed` | P7 |
| T15 | 启动钩子幂等：连跑两次不改变已 `interrupted` 的行 | P7 |
| T16 | 任意时刻在途探测数 ≤ 配置并发（默认 2） | P4 |
| T17 | 并发配置 5 被 clamp 到 4 / 校验拒绝 | P4 |
| T18 | 同源并发创建两个任务，第二个条目记 `already_running` 而非重复请求 | P4 |
| T19 | 预算耗尽后剩余条目全为 `skipped` 且 `reason` 含 `budget_exhausted` | P4 |
| T20 | 成功率分母 = testable（12），跳过不进分母 | P5 |
| T21 | `empty_results` 进「待确认」，不进分子也不进失败数 | P5 |
| T22 | `CONFIG_ERROR`（解密失败）计入失败，响应不含密文片段 | P5 |
| T23 | `invalid_response`（200 + 非法结构）判失败，`ok=false` | P5 |
| T24 | `running` 中途显示「部分完成（x/12）」，不出现「全部完成」 | P5 |
| T25 | Playwright：预检框 6 行数量 + 预算 + 付费提示 | P6 |
| T26 | Playwright：确认→进度→取消→结果表仍有已完成行 | P6 |
| T27 | Playwright：排序为失败→受限→待确认→成功→跳过 | P6 |
| T28 | Playwright：「只重测失败项」只提交失败集合 | P6 |
| T29 | Playwright：抽屉显示脱敏 Key 标签与最多 3 条样例，`requests` 缺失显示「—」 | P6 |
| T30 | i18n：`zh-CN` 与 `en` 键集合相等，页面无硬编码中文 | P6 |

## 12. 待确认问题（含默认值）

1. **`includeUnverified` 是否直接等同于「包含免 Key 来源」？** 默认：是，直接复用，不新增设置项（`healthSettingsPatchSchema` 保持字段不变）；若实施方发现语义冲突，只能新增 `includeKeyless`，不得改 `includeUnverified` 现有含义。
2. **`empty_results` 在「只重测失败项」里是否包含？** 默认：不包含——它属「待确认」，单独提供「重测待确认项」，避免把一次空结果放大成反复付费。
3. **批量任务的 `total` 是否包含被跳过的来源？** 默认：包含（`total` = 范围总数，`skipped` 单列），因为 UI 需要显示「跳过 8」而不是让 20 悄悄变成 12。
