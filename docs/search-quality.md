# 搜索质量评测实验室

「哪个搜索源更好」这个问题，没有评测数据时的答案只有两种：拍脑袋，或者看谁的宣传更响。
这个实验室存在的目的，是把它变成一个可以用固定数据、人工标注和可复现指标回答的问题。

它同时也是一份**限制声明**：合成基准的分数不能冒充真实厂商的检索质量，标注不全时不能
输出一个看起来很精确的召回率。下面每一条都对应代码里的一个约束。

---

## 一、三件必须分开的事

| 概念 | 存在哪 | 谁能改变 |
|---|---|---|
| 实现验证状态 | Provider 目录常量（`documented` / `mock_verified` / `live_tested`） | 只有人改目录 |
| 运行健康状态 | 探测结果派生（`healthy` / `cooldown` / `quota_exceeded` …） | 探测写入 |
| **检索质量** | **评测实验**（本页） | 只有跑实验才产生 |

一次探测成功说明「端点通了」，实验分数说明「排序在给定标注下更接近人工判断」。
两者互不替代，界面上也不放在同一个数字里。

## 二、相关性标注

四级量表：

| 等级 | 含义 |
|---|---|
| 0 | 不相关，或只是关键词撞上了 |
| 1 | 弱相关，提到了话题但没有回答问题 |
| 2 | 相关，能回答一部分 |
| 3 | 高度相关，直接且充分地回答搜索意图 |

- 二元指标（P@k、Recall@k、MRR@k）默认把 **≥ 2** 视为相关。
- 标注来源分 `human` / `machine_generated` / `synthetic_fixture`。**只有 `human` 是真值**。
  模型给自己生成的结果打分不算标注，写进 `machine_generated` 也不会自动升级为真值。
- 同一个文档重复标注会**替换**旧标注，不会变成两条：唯一索引在 `(query_id, document_id)` 上。

## 三、文档身份

`document_id` 是**规范化 URL**（`normalizeUrl`）：小写化 host、去默认端口、去 fragment、
剔除 `utm_*` / `gclid` 等跟踪参数、排序 query、去尾斜杠。

这样同一篇文章从三个源、带三种跟踪参数返回时，是同一个文档，不会在指标里算三次。
原始 URL 保留在结果里供审计，但**不参与身份判定**。

**不做**的事：标题相似就判同文档、跨域等价（`m.` 与桌面版）、内容指纹、向量相似度。
近似去重只用于展示，不用于评测身份。

## 四、未标注文档不是「不相关」

这是整个模块最重要的一条。

| 情况 | 处理 |
|---|---|
| 文档没有标注 | 默认 **从排序中移除**，查询标记为 `provisional` |
| 查询完全无标注 | 指标为 **N/A（no_judgments）**，不是 0 |
| 数据集声明标注不完整 | Recall 为 **N/A（qrels_incomplete）**，不计算 |
| 真值里没有相关文档 | Recall / nDCG 为 **N/A（no_relevant_documents）**，不做除零 |
| 结果为空 | 为 **N/A（no_results）** |

`as_zero` 策略可以把未标注文档当作 0 分，用于**敏感性分析**，但它永远不是头条数字：
结果仍然标记为 provisional，界面同时显示。

## 五、指标定义

设 cutoff = k（默认 10），threshold = 2。

| 指标 | 定义 | 关键约定 |
|---|---|---|
| P@k | 前 k 位中相关文档数 **÷ k** | 分母固定为 k。只返回 3 条也按 3/10 计，不会因为结果少而变成满分 |
| Recall@k | 前 k 位中相关文档数 ÷ **标注集中相关文档总数** | 只有 `judgmentsComplete=true` 才计算 |
| MRR@k | 首个相关文档排名的倒数 | 第 1 位 = 1，第 3 位 = 0.333，前 k 位无相关 = 0 |
| nDCG@k | DCG@k ÷ IDCG@k | gain = 2^rel − 1，discount = log2(i + 1)，i 从 1 开始 |

IDCG 用**标注集**的理想排序计算，而不是用「这次返回了什么」。所以漏掉相关文档时 nDCG
会下降，而不是因为「返回的都是最好的」而得 1。

聚合规则：

1. provisional 查询**不计入**头条平均值，只计入 `provisionalCount`；
2. 如果全部查询都是 provisional，聚合结果为 N/A（`qrels_incomplete`）；
3. `sampleSize` 永远返回；样本少于 8 时 `lowSample=true`，界面标注「仅供参考」。

## 六、非相关性信号（不要和相关性混为一谈）

| 指标 | 口径 |
|---|---|
| `duplicateRate` | 融合前的重复行数 ÷ 原始行数。这是「花了钱买到多少重复」 |
| `uniqueDomainCount` | 去重后不同可注册域的数量 |
| `providerCoverage` | 实际贡献了结果的源数量 |
| `sourceDiversity` | 贡献源数 ÷ min(被问的源数, 结果数)，上限 1 |
| `resultCount` | 每条查询的平均结果数 |
| `emptyResultRate` | 合法空结果的比例 |
| `failedQueryRate` | 没有拿到快照的查询比例 |
| `partialQueryRate` | 部分成功比例 |

**结果多不等于质量高，来源覆盖不能替代相关性。** 这几项和 P@k / nDCG 分开显示，不合成
一个总分——一个总分会让「多返回 20 条垃圾」看起来像改进。

## 七、延迟与成本

- 延迟报 P50 / P95 / 均值 / 最小 / 最大，并强制带 `count`。样本少于 8 标 `lowSample`。
- 成本报 **请求数**（这是确定的）、`knownCost`（配置了单价时）与 `unknownCost`。
  **没有配单价时金额是 unknown，不是 0。**
- 缓存命中不计入上游请求数（`cacheHits` 单独报）。

## 八、两种运行模式

### offline

- 读已保存的快照，或读内置合成基准。
- **不联网、不调用 Provider、不消耗任何额度。** 用没有配置任何搜索源的实例也能跑通，
  这一点由测试断言，而不是由文档承诺。
- 用于 CI、算法对比、回归测试。

### live

- 调用真实 Provider，走的是与用户搜索**同一条**链路：同一个 Key 池、同一个调度器、
  同一套 SSRF 防护、同一个健康门禁。
- 必须显式提供：`providerIds`、`requestBudget`、`confirmPaid=true`。
- 开始前按 **查询数 × 源数 × 2 次尝试** 估算最坏情况；超过预算直接拒绝，不发第一个请求。
- 运行中按实际请求数扣减，到上限就停，并把状态记录为预算耗尽。
- 结果**不写入 `search_tasks`**，也**不读写响应缓存**：实验不能污染用户流量的成功率，
  也不能被昨天的缓存当成本次检索结果。
- 取消不会退还已发出的请求额度——只有能证明尚未发出的预留才可退还。这与健康探测一致。

CI 中**只跑 offline**。任何测试都不调用收费服务。

## 九、公平比较

两个方案对比时，必须固定：

- 查询集合；
- 数据集版本（不同版本直接拒绝比较，因为那是两个不同的问题）；
- 相关性标注；
- top K 与 cutoff；
- 原始检索结果快照；
- 去重口径与指标公式。

因此对比有两种做法：

1. **同一快照重排**（`snapshotRunId`）：抓一次原始结果，用不同融合策略重新排序。
   这是唯一能说「A 算法比 B 算法好」的形态。
2. **两次独立实验**：只有数据集版本相同才允许比较，且必须承认两次抓取的时间不同。

对比输出：基线分、候选分、绝对差值、相对变化、有效查询数、未标注比例、改善查询、
退化查询、延迟、请求数、费用。

**证据不足时输出 `INSUFFICIENT_EVIDENCE`，不输出胜负。** 触发条件：有效对比查询少于 8 条，
或任一方的指标本身是 N/A，或平均差值低于 0.01。

## 十、RRF 离线参数实验

生产默认仍是 `k=60`，本轮**不改线上排序**。

实验步骤：

1. 按查询 id 做确定性划分：排序后交替分配为 development / holdout；
2. 候选参数（默认 k = 20 / 40 / 60 / 80 / 100）只在 development 上评估；
3. 选出 development 上最好的 k；
4. 在 **holdout** 上，把它与 k=60 对比；
5. 输出 `evidence: sufficient | INSUFFICIENT_EVIDENCE`。

在 holdout 上挑参数、再用同一个 holdout 宣称泛化，是这类实验最常见的自欺方式，代码里
没有提供这条路径。

`holdoutVerdict` 在证据不足时为 `null`——一个叫 verdict 的字段不该装「我不知道」。

## 十一、数据表

| 表 | 内容 |
|---|---|
| `quality_datasets` | 名称、版本、状态（draft/frozen）、来源、标注是否完整 |
| `quality_queries` | 查询、类别、语言、意图 |
| `quality_judgments` | 每查询×文档一条，四级相关性，标注人与来源 |
| `quality_runs` | 数据集版本、commit、引擎版本、融合参数、预算与实际请求数、状态 |
| `quality_snapshots` | 每个查询的原始 per-provider 结果列表（可重排的输入） |
| `quality_run_results` | 每个查询的排序结果与指标（可追溯到具体文档） |

- 冻结（freeze）后不可原地修改；`fork` 复制为新的草稿版本，旧版本保留。
- 删除数据集会级联删除其查询与标注；实验记录独立保留，用于追溯。
- `prune` 按保留天数清理旧实验，保留最近 N 次。

## 十二、接口

全部需要 `admin` 权限，写操作需要 CSRF。`search` 作用域的 Token 一律 403。

```
GET    /api/admin/quality/datasets
POST   /api/admin/quality/datasets
GET    /api/admin/quality/datasets/:id
POST   /api/admin/quality/datasets/:id/queries
POST   /api/admin/quality/datasets/:id/judgments
POST   /api/admin/quality/datasets/:id/freeze
POST   /api/admin/quality/datasets/:id/fork
GET    /api/admin/quality/datasets/:id/export
POST   /api/admin/quality/datasets/import
GET    /api/admin/quality/runs
POST   /api/admin/quality/runs
GET    /api/admin/quality/runs/:id
POST   /api/admin/quality/runs/:id/cancel
GET    /api/admin/quality/compare?baseline=&candidate=&metric=
POST   /api/admin/quality/sweep
POST   /api/admin/quality/prune
```

错误映射遵循全局约定：参数错误 400、不存在 404、状态冲突 409（冻结后修改、取消已结束的
实验）、权限 403。**客户端错误不会包装成 500。**

## 十三、内置合成基准

两个内置数据集，`origin: synthetic_fixture`：

| 数据集 | 查询 | 标注 | 用途 |
|---|---|---|---|
| `ds_synthetic_core_v1` | 14 | 56（完整） | 指标可计算，含 Recall |
| `ds_synthetic_shallow_v1` | 6 | 14（仅正例） | 演示 N/A Recall 与 provisional |

- 所有 URL 都在 `*.fixture.test` 下，不可能被误认为真实站点。
- 标注是手写的，不是模型生成的。
- **它们证明的是评测机制正确，不是任何厂商的检索质量。** UI 上这句话就写在数据集卡片里。

## 十四、CI 门禁

```bash
pnpm quality:eval --baseline tests/fixtures/quality-baseline.json --max-drop 0.02
```

- 默认全部离线，不需要 Key，不联网；
- 先跑 11 项手算自检（完美排序 = 1、逆序下降、DCG 公式、N/A 语义、未标注处理、空样本、
  未知成本…），任一失败即 exit 1；
- 再与提交的基线比较 `rrf:k=60` 的 nDCG@10，下降超过阈值即 exit 1；
- 报告可写到 `--out`，格式 `search-hub.quality.report/1`；
- 证据不足时输出 `INSUFFICIENT_EVIDENCE`，不伪造通过。

更新基线是显式动作：改了算法并确认结果合理后，重新生成 `tests/fixtures/quality-baseline.json`
并在 PR 里说明原因。CI 不会自动更新它。
