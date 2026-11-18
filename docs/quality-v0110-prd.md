# PRD：搜索质量评测实验室 · v0.1.10-beta.1 增量

> 本文件只覆盖**尚未满足的缺口**。已建成的能力（四级标注、P@k/Recall@k/MRR@k/nDCG@k 与全套 N/A 语义、成本与延迟口径、offline/live 双模式、dev/holdout 划分、RRF sweep、合成 fixture、CI 门禁）不在本文重复描述，也不重做。

## 0. 项目信息

| 项 | 值 |
|---|---|
| Language | 中文 |
| Programming Language | 现有栈：TypeScript / Fastify / Drizzle / Vite + React + MUI + Tailwind |
| Project Name | `search_hub_quality_lab_gap_closure` |
| 版本号 | v0.1.10-beta.1 |
| 迁移编号 | `0007`（接 `0006_search_quality.sql`，仅 `ALTER TABLE ADD COLUMN`） |
| 原始需求 | 在已建成的评测实验室之上补齐 7 个规格缺口：多分类标签、实验溯源、运行配置项、Provider 权重证据、对比报告两块内容、未标注结果可见性、三个运维边界。不改生产排序，不动已发布产物。 |

## 1. 产品目标与不做什么

**一句话**：把评测实验室从「能跑出分数」升级为「分数可复现（谁 / 什么配置 / 什么标注集）、结论可分维度（按查询类别）、失败可诊断（不留半截数据）、大数据集不炸内存」。

### 本轮不做（硬约束）

1. **不修改生产 RRF**：`fuseWithRrf` 默认 `k=60`、`score = Σ w/(k+rank)`、tie-break 顺序（fusionScore → bestRank → sources 数 → url）保持字节级不变；新增算法只跑在离线评测路径。
2. 不移动、不删除已有 git tag，不重复发布 `v0.1.8-beta.1`。
3. 不引入第二套 UI 框架或新组件库，只用现有 Tabs / Card / Table / Drawer。
4. 不做 AI 自主路由、不做按分数自动切换 Provider。
5. 不把 `synthetic_fixture` 的分数表述为真实厂商检索质量；数据集卡片里的告示保留。
6. 不把 `unjudged` 当作 `relevance=0`（`as_zero` 仅作敏感性分析，既有语义不变）。
7. 不为通过测试修改数学预期值，不调整 CI 门禁阈值（`--max-drop 0.02` 不动），基线文件不自动更新。
8. **不做并发执行、不做实验级缓存**：`maxConcurrency > 1` 与 `cachePolicy !== "bypass"` 一律拒绝（见 §5.4）。下一轮候选，不是本轮缺陷。
9. 不新增第二条 UI 信息架构；现有四个标签页（数据集 / 实验 / 对比 / 历史）不变。
10. 不重写已通过的质量专项测试（44 单测 + 35 集成 + 9 accounting + 4 gate + 4 migration）。

## 2. 用户故事

1. 作为**实例管理员**，我要给一个查询挂多个类别标签（如 `code` + `english`），以便一条查询在多个维度统计里都能出现，而不用复制成两条查询污染数据集。
2. 作为**管理员**，我要在实验详情里看到「这次用了哪些 Provider、什么配置、哪个标注集版本」，以便三个月后有人问「这个分数怎么来的」时我能指出来，而不是只能说「当时跑过」。
3. 作为**管理员**，我要能分别设置最终返回条数和每源条数，以便区分「多召回一些再融合」和「多给用户看几条」，而不是被一个 `limit` 同时绑住。
4. 作为**管理员**，我要看到两个方案对比时每个查询的文档排序具体怎么变了（谁上移、谁掉出去、掉出去那条相关性几级），以便判断退化是「换了排序」还是「丢了正确答案」。
5. 作为**管理员**，我要看到按查询类别分组的对比结果，以便知道某次改动是不是只让 `news` 变好、却让 `code` 变差（平均值会掩盖这件事）。
6. 作为**管理员**，我要能点开「未标注」数字看到具体哪些查询、哪些文档没标注，以便决定补标注还是先接受 provisional。
7. 作为**运维者**，我要在磁盘写失败时看到实验被明确标记为失败、且已写入的部分不丢，以便不把残缺实验当成功结果引用。
8. 作为**运维者**，我要在导入数据集时确信它不写文件、不执行内容、不被超大 payload 拖死，以便敢把导出的文件导进另一台实例。

## 3. 已定稿决策（本轮口径，实施不得偏离）

| # | 决策 |
|---|---|
| D1 | **编号**：规格中确实存在的 `T31 / T46 / T47 / T48` 原样沿用；规格里不存在、或含义对不上的（原 T19 是「未标注文档不默认为 relevance=0」，原 T34 是「开发集与 holdout 隔离」）**不得借用**，一律用 `G1`…`G7` 加子号（`G1-a`、`G5-b`）。不臆造 `T49` 一类编号。 |
| D2 | **`GET /datasets/:id` 不改既有字段**：`queries`、`judgments`、`coverage` 三者名称与类型不变（35 个集成测试依赖它们）。新增 `queriesPage: { total, hasMore, offset, limit }` 与 `judgmentsPage` 同结构；默认 limit 200，最大 500。**非破坏性**，但必须明确：超过 200 条时 `queries` 不再等于全部，前端走「已显示 200 / 共 N 条，加载更多」路径。 |
| D3 | **`modelFingerprint = null` 是事实而非缺失**：表示「本次实验没有任何模型参与」。`provenanceComplete` 只由 `providerIds` / `providerFingerprint` / `qrelsFingerprint` 决定。旧 run 四列全空 → `provenanceComplete = false` 且 `missing: ["providerIds","providerFingerprint","modelFingerprint","qrelsFingerprint"]`。**禁止**用当前配置回填补算历史 run。 |
| D4 | **507 不新增错误码**：用 `new SearchHubError("internal_error", msg, { status: 507 })`，`STATUS_BY_CODE` 不改，`sendError` 直接读 `error.status`。其余写错误 500；客户端 4xx 不得被包成 5xx。 |
| D5 | **并行与缓存本轮不做**：`maxConcurrency > 1` 或 `cachePolicy !== "bypass"` 一律 `400 unsupported_option`，消息必须含 `not implemented in this version`。禁止存进库再串行执行——让报告的配置与真实执行不符，比不支持更糟。 |
| D6 | **Provider 集合落库**：`quality_runs` 新增 `provider_ids_json`（架构需求已纳入）。这是溯源可解释的前提，不是可选项。 |

## 4. 需求池

### P0

| ID | 需求 | 对应缺口 | 验收标准（可测量） | 测试编号 |
|---|---|---|---|---|
| **G1-a** | `quality_queries` 新增 `extra_categories`（JSON 数组，默认 `[]`），保留 `category` 为主分类；单查询最多 3 个类别（1 主 + 2 副），不得重复、不得把主分类重复塞进副分类 | G1 | 迁移 `0007` 空跑两次幂等；旧行读出 `categories === [category]`；非法组合（重复 / 4 个 / 主分类混入）返回 400 | G1-a-1..3 |
| **G1-b** | 分组统计：实验详情与对比新增 `byCategory`，多标签查询在每个类别各计一次并返回 `overlappingGroups: true`；提供 `groupBy=category_primary` 只看主分类 | G1 / G5-b | `code+english` 查询在两组各出现一次；`Σ groupQueryCount ≥ queryCount`；`category_primary` 模式下严格相等 | G1-b-1..3 |
| **G2-a** | `quality_runs` 新增 `provider_ids_json`、`provider_fingerprint`、`model_fingerprint`、`qrels_fingerprint`、`judgment_count` | G2 | 同配置连跑两次三个指纹相同；改某 Provider 的 `maxConcurrency` → `providerFingerprint` 变；**改 API Key → 不变**（密钥不进指纹）；任一 judgment 的 `relevance` 改动 → `qrelsFingerprint` 变 | G2-a-1..4 |
| **G2-b** | 溯源完整性显式表达，历史 run 不得伪装完整 | G2 | 新 run：`provenanceComplete=true`，`missing=[]`；旧 run：`false` + 四列全列进 `missing`；纯 offline 无模型：`modelFingerprint=null` 但 `provenanceComplete=true`（D3） | G2-b-1..2 |
| **G3-a** | `RunInput` 新增 `perProviderLimit`(1..50，默认 = `limit`) 与 `timeoutMs`(500..60000，默认取引擎默认)，落库并在 `RunSummary` 回显（含 `defaulted` 标记） | G3 | 显式传值后 `GET /runs/:id` 原样返回；不传时取默认且 `defaulted.perProviderLimit=true`；`perProviderLimit > limit` 合法 | G3-a-1..3 |
| **G3-b** | 未实现取值必须拒绝（D5） | G3 | `maxConcurrency=2` → 400 `unsupported_option`，消息含 `not implemented in this version`；`cachePolicy="isolated"` 同样 400；两值均不得出现在任何已落库的 run 上 | G3-b-1 |
| **G3-c** | 预算预估按 `perProviderLimit` 折算分页 | G3 | `perProviderLimit=50`、单页 10 → 每查询每源按 5 次计入最坏情况；预估值 ≥ 实际值（现有 `requestsPerQuery` 只算 2 次尝试，会低估） | G3-c-1 |
| **T31-a** | Provider 权重真实作用断言（纯测试需求，冻结生产语义） | G4 | 见 §5.5 六条断言；`weights` 全为 1 与不传 weights 结果**深度相等**；CI 内可跑 | T31-a-1..5 |
| **G5-a** | 对比报告新增文档级排序变化 `movements[]`（默认仅 judged 文档、每查询 top 20、按 \|Δrank\| 降序） | G5 | 单侧存在 → `movement=entered/exited` 且 `deltaPositions=null`（不是 0，不是 Infinity）；两侧都不存在 → 不出现；未标注文档默认不返回并给出 `hiddenUnjudgedMovements` 计数 | G5-a-1..4 |
| **G5-b** | 对比报告新增 `byCategory`；样本 <8 或指标为 N/A 的组一律 `insufficient_evidence` | G5 | 6 条查询的类别组即使 Δ=0.30 也判 `insufficient_evidence`；N/A 组不进头条平均 | G5-b-1..2 |
| **G6-a** | `GET /datasets/:id/coverage` 返回 keyset 分页的未标注查询列表 | G6 | 默认 50 / 上限 200；`total` 与 `getDataset.coverage.unjudgedQueries` 一致；SQL 用 `NOT EXISTS`，不把 2 万条 judgment 读进内存 | G6-a-1..3 |
| **G6-b** | `GET /datasets/:id/queries/:qid/unjudged` 返回该查询在历史 run 结果中出现过但无标注的文档 | G6 | 返回 `documentId` / `url` / `bestRank` / `providers` / `seenInRuns`；从未跑过实验 → `documents=[]` + `reason=no_run_results`（不得表现为「全部已标注」） | G6-b-1 |
| **T46** | 写失败必须留下确定状态：run 置 `failed` + `failureReason` + `persistedQueryCount` | G7 | 注入抛错 db stub → 507、`status=failed`、`failureReason=persistence_failed`、已写入部分仍可读、**不返回 200** | T46-a-1..3 |
| **T47** | 分页取代全量读取：`GET /datasets` 分页（默认 50 / 上限 200，`nextCursor`）；`GET /datasets/:id` 按 D2 加 `queriesPage` / `judgmentsPage`；新增 `/queries`、`/judgments` 分页子资源 | G7 | 500 查询数据集下任一单次查询返回行数 ≤ limit；翻完 500 条总 SQL 次数 ≤ 12；游标非法 → 400（不是 500） | T47-a-1..3 |
| **T48** | 导入安全：严格 schema、体积上限、危险键与危险 URL 拒绝 | G7 | 见 §5.7 拒绝清单；每个恶意样例返回指定码而非 500；合法导入仍 200 且计数不变 | T48-a-1..6 |

### P1 / P2

| ID | 需求 | 优先级 | 对应缺口 | 验收标准 | 测试编号 |
|---|---|---|---|---|---|
| G2-c | 重放计划 `GET /runs/:id/replay-plan`（回显完整可复现配置，不含密钥） | P1 | G2 | 用该 plan 重跑，`providerFingerprint` 与 `qrelsFingerprint` 与原文一致 | G2-c-1 |
| G6-c | 数据集级未标注文档汇总（按 `seenInRuns` / `bestRank` / `providers` 聚合） | P1 | G6 | 与逐查询结果的并集一致；分页稳定 | G6-c-1 |
| G6-d | 未标注抽屉内「标记为不相关」快捷标注（`relevance=0, source=human`，二次确认） | P1 | G6 | 标注后 `unjudgedQueries` 减 1；`assessor` 记为当前管理员 | G6-d-1 |
| T31-b | sweep 候选网格支持 `providerWeights` 组合（仅离线） | P2 | G4 | 每个候选取用的 weights 写进结果行 | T31-b-1 |
| G3-d | `maxConcurrency > 1` 的真并行（预算计数需先检查后自增的原子序） | 下一轮 | G3 | 并发 4 与串行 1 在同一快照上指标完全相同 | — |
| G3-e | `cachePolicy="isolated"` run 作用域缓存 | 下一轮 | G3 | `cacheHits > 0` 且不污染用户缓存 | — |

## 5. P0 边界条件与错误处理

### 5.1 状态码语义（不新增 code 的清单除外）

| 场景 | 状态码 | `code` |
|---|---|---|
| 字段类型 / 范围 / 跨字段冲突 | 400 | `validation_error` |
| 明确的未实现取值（D5） | 400 | `unsupported_option` |
| 数据集 / run 不存在 | 404 | `not_found` |
| 冻结后修改、取消已结束实验 | 409 | `conflict` |
| 数据集版本不同 | 409 | `dataset_version_mismatch` |
| qrels 指纹不同但版本号相同 | 409 | `qrels_mismatch` |
| body 超限 | 413 | `payload_too_large` |
| 非 JSON | 415 | `unsupported_media_type` |
| 落盘失败（ENOSPC / SQLITE_FULL） | **507** | `internal_error` + `{ status: 507 }`（D4） |
| 其余 | 500 | `internal_error` |

客户端错误（400/404/409/413/415）**一律不得**被包装成 5xx。

### 5.2 G1 的兼容语义

`category` 保持 NOT NULL（默认 `general`），因此**旧客户端不传 category 依然合法**；`extraCategories` 缺省视为空数组。导出文件写 `extraCategories`；导入时缺省容忍，未知类别名返回 400 并带 `queries[i]` 索引，不静默丢弃。

### 5.3 G5 的 N/A 语义

| 面 | 条件 | 输出 |
|---|---|---|
| 类别组指标 | 组内全部 provisional | `null` + `reason=qrels_incomplete`，不进头条 |
| 类别组 Recall | `judgmentsComplete=false` | `null` + `reason=qrels_incomplete` |
| 类别组判定 | 可比查询 <8 | 值照给 + `lowSample=true` + `verdict=insufficient_evidence` |
| 文档位移 | 仅一侧存在 | `deltaPositions=null`，`movement=entered`/`exited` |
| 文档位移 | 两侧都不存在 | 不出现在 `movements[]` |
| 溯源 | v0.1.10 之前的 run | 四列为 `null`，`provenanceComplete=false`（D3） |
| 未标注文档 | 该查询从未跑过实验 | `documents=[]` + `reason=no_run_results` |

**`byCategory` 的组是多标签重叠的**：UI 必须显示「多标签查询会在多个类别各计一次」，禁止把各组合并回一个总数宣称等于查询总数。

### 5.4 G3 的边界

- `perProviderLimit > limit` 允许（先多召回再截断），两者均 ≤50。
- `timeoutMs` 只作用于本次评测请求，不写回 Provider 配置；越界 400，**不得 clamp**——静默 clamp 会伪造配置记录。
- `cachePolicy` 默认 `bypass`（等于现状）。非 `bypass` → 400 `unsupported_option`。
- `maxConcurrency` 默认 1。`>1` → 400 `unsupported_option`。**宁可不支持，也不要在库里记一个没生效的配置。**

### 5.5 T31 六条断言

1. 两源文档基排名相同，A 权重 2 / B 权重 1 → A 的文档排在前。
2. 权重 0 → 该源贡献 0 分，文档仍保留（`bestRank` 来自该源），不产生 `NaN`。
3. 全部权重为 1 与不传 `providerWeights` → 结果深度相等（保护生产路径）。
4. 同 URL 由 A(权重 2, rank 1) 与 B(权重 1, rank 2) 返回 → `fusionScore = 2/(k+1) + 1/(k+2)`；同源重复 URL 只计一次。
5. 等分时 tie-break 仍按 bestRank → sources → url；同一输入两次结果逐字节相同（加权重不破坏确定性）。
6. lab 级：同一快照用 `[A:3,B:1]` 与 `[A:1,B:3]` 重排，在 A 明显更优的 fixture 上 nDCG@10 必须出现差异且方向正确。

### 5.6 T46 / T47 的实现约束

- `persistResult` 失败时**先**把 run 置 `failed` 并写 `failureReason`，再向上抛；若连 run 状态都写不进（同一次磁盘故障），仍返回 507，并在响应 `detail` 给出 `runId`，便于磁盘恢复后核对。
- 已持久化的查询结果**不得回滚**；`persistedQueryCount` 记录真实条数；`GET /runs/:id` 返回 `partial: true`。
- 预算耗尽**不算失败**：状态仍 `completed` + `budgetExhausted: true`（保持既有语义）。
- 分页一律 keyset，禁止 offset（深翻页在 2 万条 judgment 上是 O(n²)）。游标非法 → 400；游标指向的行被删除 → 按「大于该键」继续，不 404。
- `GET /datasets/:id` 超过 200 条时 `queries` 不再是全集（D2），必须同时给出 `queriesPage.total`；前端在同一 PR 内改完，CHANGELOG 标注。

### 5.7 T48 拒绝清单

`__proto__` / `constructor` / `prototype`（任意深度，含数组元素内的对象）、嵌套 >8 层、控制字符 U+0000–U+001F、`javascript:` / `file:` / `data:` / `vbscript:` URL、未知顶层或查询级键、body >5 MB、非 JSON body。全部返回 §5.1 指定码，且**先全量校验后单事务写入**，不产生部分写入。导出文件名不参与路径构造：`Content-Disposition` 只保留 `[A-Za-z0-9._-]`，其余降级为 `quality-dataset-<id>.json`。

## 6. UI 变更点

现四个标签页结构不变，新增内容落在既有卡片内的分区，不新开页面。i18n 新增约 30 个 `quality.*` 键，中英同批（当前各 133 条，本轮后数量必须一致）。

### 数据集 tab

1. **查询编辑器**：类别从单下拉改为「主分类下拉 + 副分类 chips（+ 添加，最多 2 个）」，超限时按钮禁用。文案：`最多 3 个类别（1 主 + 2 副）` / `Up to 3 categories (1 primary + 2 secondary)`。
2. **类别筛选**：从「等于」改为「包含任一」，旁挂提示 `筛选匹配任一标签` / `Filter matches any label`。
3. **覆盖度横幅**：未标注查询数变可点击链接 → 右侧 Drawer：未标注查询列表（分页 + 每条显示历史出现次数）→ 点进单条看文档列表（URL、历史最佳排名、来源；P1 加「标记为不相关」）。空态区分 `no_run_results` 与「全部已标注」。
4. **查询/标注列表**：底部 `已显示 200 / 共 N 条，加载更多`；数据集列表同样加 `加载更多`。

### 实验 tab

1. **新建实验 · 高级参数折叠区**：`perProviderLimit`（提示「每源取多少条，影响请求数与费用」）、`timeoutMs`、`maxConcurrency`（固定 1，输入框禁用 + 提示「本轮仅支持串行」）、`cachePolicy`（固定 `bypass`，提示「实验不读写用户缓存」）。默认值用浅灰占位符显示，改过的字段加 `已修改` 徽章。
2. **实验详情「溯源」行**：数据集版本、`qrels 指纹`（前 8 位 + hover 全量）、`Provider 配置指纹`（前 8 位 + Provider 数量 + id 列表）、模型指纹（`null` → `未使用模型` / `no model involved`，**不显示为缺失**）、commit、引擎版本。`provenanceComplete=false` 时显示灰色徽章 `溯源不完整（v0.1.10 之前）` / `Incomplete provenance (pre-v0.1.10)`。
3. **运行卡片**：显示 `perProviderLimit × Provider 数` 的预估请求数；失败卡片显示 `failureReason` 的四类文案（磁盘写入失败 / 预算耗尽 / 已取消 / 内部错误）与 `已保留 N 条结果`。

### 对比 tab

1. 顶部新增**按类别分组表**：类别 / 查询数 / 可比查询数 / 基线 / 候选 / Δ / 判定 / 低样本标记；表下灰字 `多标签查询会在多个类别各计一次，合计大于查询总数` / `Multi-label queries are counted once per category, so the total exceeds the query count`。
2. 单查询行可展开 → **排序变化列表**：文档（截断 URL，hover 全量）/ 相关性等级徽章（0–3 四色，沿用现有标注色）/ 基线名次 / 候选名次 / 位移（`↑3`、`↓2`、`新进入`、`移出`）。上方一行 `已隐藏 N 个未标注文档的位移`，点击可临时显示（保留 `未标注` 灰标）。
3. `INSUFFICIENT_EVIDENCE` 保持现有呈现，**永不**显示胜负色；类别组内证据不足同样置灰。

### 历史 tab

分页 + 状态筛选；失败行显示 `failureReason`；`partial: true` 行加 `部分结果` 徽章，进入详情时顶部提示。

## 7. 交付与验收口径

- **迁移**：`0007` 仅新增列，无破坏性变更，空跑两次幂等。
- **新增测试**：计划 47 条，其中 P0 38 条（G1 6 / G2 6 / G3 5 / T31 5 / G5 6 / G6 4 / T46 3 / T47 3 / T48 6）。
- **回归门槛**：现有 876 passed / 60 files 全绿；`pnpm quality:eval --baseline tests/fixtures/quality-baseline.json --max-drop 0.02` 仍通过且基线文件不更新。
- **文档**：`docs/search-quality.md` 增补「类别多标签」「溯源字段」「运行配置项」「对比报告结构」「运维边界」五段；`docs/api.md` 增补新接口与字段；CHANGELOG 记 v0.1.10-beta.1。
