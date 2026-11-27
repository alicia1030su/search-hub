# Search Hub v0.1.18 真实查询集与质量评测协议

## 1. 目的与交付物

本协议冻结 v0.1.18 真实查询集的结构、抽样、qrels、缺失处理和 live 配对方法，供同快照算法对比与 live AB/BA 使用。

- 查询集：`tests/fixtures/quality-v0118/queries.json`
- 规模：40 条查询、80 条 qrels、8 个观测 stratum，每个 stratum 5 条。
- 标签来源标识：`human-curated-v1`；所有条目 `provisional=false`。
- 相关性量表：0=不相关，1=弱相关/部分答案，2=直接回答。
- 本数据集**不是完整 qrels**：每条查询只冻结一个主答案（2）和一个相关背景页（1），没有穷举所有相关文档。因此可以计算 nDCG@10、MRR@10、P@10，**不得计算 Recall 或宣称召回率提升**。

## 2. 抽样设计

| category | stratum | 查询数 | 查询语言 | 主答案语言 | 覆盖目标 |
|---|---:|---:|---|---|---|
| zh_web | `zh:zh_web` | 5 | 中文 | 中文 | 中文政府、法律、统计与机构网页 |
| en_web | `en:en_web` | 5 | 英文 | 英文 | 国际组织、科学机构与公共知识网页 |
| technical | `en:technical` | 5 | 英文 | 英文 | Web API、异步取消、数据库、HTTP 标准 |
| academic | `en:academic` | 5 | 英文 | 英文 | Transformer、BERT、GPT-3、ResNet、Adam 原始论文 |
| news_time | `zh:news_time` | 5 | 中文 | 中文/英文 | 有明确日期和官方记录的新闻/时效事件 |
| long_tail | `zh:long_tail` | 5 | 中文 | 中文 | 具体法规、税务、标准与知识产权长尾查询 |
| proper_noun | `en:proper_noun` | 5 | 英文 | 英文 | JWST、LHC、Euclid、NIST CSF、OpenAPI 精确实体 |
| cross_lingual | `zh:cross_lingual` | 5 | 中文 | 英文 | 中文查询检索英文权威页面 |

### 2.1 入样标准

1. 查询具有明确信息需求，不依赖个人背景、账号或付费墙。
2. 主答案来自官方文档、原始论文、政府/监管机构或国际组织页面；不使用搜索摘要、聚合页或来源不明镜像作为主答案。
3. URL 稳定、公开、允许访问；不依赖会话 token、Cookie、一次性跳转或搜索跟踪参数。
4. `normalizedUrl` 使用既有 `normalizeUrl` 口径：小写 host、去默认端口/fragment/跟踪参数、排序 query、去尾斜杠；保留有语义的 query（例如 NASA 的 `?p=`）。
5. 同一查询内 URL 不重复；不同查询可复用同一权威页面，以测试不同语言和意图下的排序稳定性。
6. 每个 stratum 至少 4 条；本版本冻结为 5 条，满足 PRD B8 的分层最小样本要求。

### 2.2 构建与核验

- 通过公开搜索发现一手来源，再访问官方页面核对标题、主题与查询意图；未使用登录态。
- 对返回 404、登录墙、验证码或无法确认主题的候选不纳入主样本。当前 40 条均已在构建时确认官方页面内容与标题。
- `human-curated-v1` 是任务约定的人工策展流程版本标识，不表示每个 URL 都由两名标注者独立复核。正式发布证据应由团队完成人工抽检并签核。
- 不使用模型自动打分来生成或升级 qrels；模型输出即使写入 `machine_generated` 也不能替代本文件的人工标签。

## 3. qrels 规则

### 3.1 标签含义

| relevance | 判定 |
|---:|---|
| 0 | 不相关，或仅关键词命中；本版本未选择此类背景页 |
| 1 | 与查询主题相关，但只提供部分答案、上位法、架构背景、镜像或更窄范围 |
| 2 | 官方主答案，直接回答查询中的实体、标准、事件或问题 |

### 3.2 记录结构

每条 query 必须包含 `queryId/query/language/category/stratum/labels`；每条 label 必须包含：

```text
relevance, normalizedUrl, title, reason, annotator, provisional
```

- `queryId` 全局唯一且冻结，格式 `q0118-001`…`q0118-040`。
- `annotator` 固定为 `human-curated-v1`。
- `provisional=false` 表示 URL 与主题已核实；若未来链接失效或主题变化，必须新建数据集版本，不能静默改标签。
- `reason` 说明为什么该页是主答案或背景页，供复核与争议处理。

### 3.3 未标注与文档身份

- 搜索结果中不在 `labels` 里的文档一律是 **unjudged**，不是 relevance=0。
- 评测身份只使用规范化 URL；标题相似、跨域镜像、`m.` 与桌面版不会自动合并。
- 不得为了提升分数把新发现的相关文档临时加入冻结集；需要补充时创建 `human-curated-v2` 并重跑全部对比。

## 4. 冻结、划分与变更

- 本版本 40 条全部作为最终 holdout，不在本数据集上调策略、阈值或融合参数。
- 如果后续必须开发/验证分开，应先冻结新版本和 deterministic split，再查看结果；禁止看到分数后按有利方式重新划分。
- `queries.json` 的 SHA-256、v0.1.17/v0.1.18 exact commit、qrels 指纹必须写入实验报告。
- 运行期间不得修改查询、标签、URL 或 stratum。链接失效记为 missing/失败证据，不原地替换。

## 5. 评测与 Missing/Attrition

### 5.1 两套证据

1. **同快照重排**：抓取一次原始 per-provider 结果，分别用 v0.1.17 和 v0.1.18 的融合/重排逻辑执行。用于隔离算法变化。
2. **Live AB/BA**：使用生产 SearchService、Key 池、限流、SSRF 与健康门禁进行真实联网配对。用于验证端到端行为，不替代同快照证据。

### 5.2 Missing 规则

- 无人工标注或 provisional 查询：不进主样本。
- 任一侧执行失败、预算耗尽或超时：整对排除，记录 `excludedReason`，不得用 0 填充。
- 有效空结果：展示层保持既有 `N/A(no_results)`；发布决策的 `releaseScore` 将 nDCG/MRR/P 记为 0，避免通过少返回结果获得优势。
- 未标注文档：不按 0 填充；provisional 查询不进头条平均。
- Recall：本数据集 qrels 不完整，始终为 N/A，不参与发布门槛。
- 报告必须给出 `expectedPairs/pairedN/excludedN` 与逐条原因；attrition >20% 时证据不足。

### 5.3 Bootstrap

- 配对 query 级重采样 10,000 次，seed=`118`，PRNG=`mulberry32`。
- 按 `language × category` 分层；层按名称排序、层内 queryId 升序；iteration 外层、stratum 内层调用同一个 PRNG。
- 每层有放回抽取与原层相同数量，同一抽取索引同时应用于两个版本；先算层均值，再按冻结样本层大小占比加权。
- 使用 2.5/97.5 百分位区间，不使用 BCa。任一层 <4 条时输出 `INSUFFICIENT_EVIDENCE`，不合并层级伪造置信度。
- observed 与 releaseScore 分别报告有效配对数和区间；提升结论必须在两种口径下方向一致。

## 6. Live AB/BA 协议

1. 冻结查询顺序、Provider 集合、非密配置指纹、模型阶段与 limit/perProviderLimit；两版本使用同一配置。
2. 同一实例、同一区域执行；关闭响应缓存；单查询串行，避免版本间资源争抢。
3. 按 queryId 奇偶交替 AB/BA：奇数 A=v0.1.17、B=v0.1.18；偶数顺序反转，降低时间漂移偏差。
4. 时间窗不超过 24 小时；每查询最多 2 次尝试，仅网络错误、5xx、429 可重试并遵守 `Retry-After`；鉴权/配额失败不重试。
5. 每对保存原始 per-provider 快照及哈希、实际请求数、延迟、错误、退化和缓存命中状态。
6. snapshot 与 live 分开统计，禁止合并 bootstrap；未执行到的查询不得补造分数。
7. 无付费 Key 时，结论限定于实际使用的公开/自托管 Provider，不得外推为付费源质量。

## 7. 证据边界

- 这是 40 条人工策展的真实网页查询，不是全网随机样本；官方来源占比高，不能代表所有网页、所有语言或所有商业搜索质量。
- 80 条 qrels 只覆盖主答案与背景页，不能证明召回完整性。
- 新闻/时效页可能后续更新；live 结果会随时间变化，必须记录运行时间窗和快照哈希。
- `cross_lingual` 刻意使用中文查询与英文答案，不能把其分数直接等同于中文网页质量。
- 通过链接可访问不等于允许批量抓取；评测只请求必要页面，遵守站点条款、限流与 robots 约定。
- 任何“质量提升”声明必须同时满足 PRD 的样本、置信区间、分类护栏与延迟门槛；否则只报告事实与限制。

## 8. 提交前检查

- [ ] JSON 可解析，`queryCount=40`、`labelCount=80`。
- [ ] 8 个 stratum 各 5 条，中英文查询均不少于 4 条。
- [ ] `queryId` 唯一；每条查询至少一个 relevance=2，且同查询 URL 不重复。
- [ ] 所有 label 含规定字段，`annotator=human-curated-v1`、`provisional=false`。
- [ ] URL 为规范化 HTTPS 地址，无跟踪参数、片段或会话凭证。
- [ ] 报告记录 queries.json SHA-256、双版本 commit、Provider 配置指纹与运行时间窗。
