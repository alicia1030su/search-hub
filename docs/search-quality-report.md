# Search Hub 多源搜索质量报告（数字口径）

生成时间：2026-11-13T16:53:00.094Z
目标实例：`http://127.0.0.1:8830`（version 0.1.2）

> 本报告只记录可复现的数字，不含主观质量评分，也不对任何 provider 排名或下「更好」的结论。
> 数字含义受每个源的索引范围限制：Hacker News 是技术社区垂直搜索，不是通用网页搜索，中文时事覆盖差属预期。

## 1. 环境与被测源

| 源 ID | 名称 | 类型 | mock | 计入融合 |
|---|---|---|---|---|
| prv_182999b2f81c4fb0a19c | hn-live | hackernews | 否 | 是 |

请求口径：每个 query 对 1 个源各 1 次单独调用 + 1 次融合调用；`mode=rrf`，`limit=10`，`skipCache=true`（强制真实调用）。

## 2. 请求汇总

| 指标 | 数值 |
|---|---|
| 总请求数 | 8 |
| 成功（completed/partial） | 8 |
| 失败 | 0 |
| 失败码 | 无 |

## 3. 逐 query 结果

### zh-news — 中文时事

查询：`国内 新能源汽车 出口 最新政策`

中文时政查询；对非中文索引的源天然不友好，仅记录数字。

| 源 | 类型 | HTTP | 状态 | 原始条数 | 去重后 | 返回条数 | 有效 URL | 有效唯一 | 返回重复率 | 原始重复率 | 服务端 ms | 客户端 ms | 失败码 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hn-live | hackernews | 200 | completed | 0 | 0 | 0 | 0 | 0 | 0.0% | n/a | 1542 | 1550 | — |
| **全源融合** | — | 200 | completed | 0 | 0 | 0 | 0 | 0 | 0.0% | n/a | 473 | 475 | — |

融合状态：partial=false，failedSources=[]，degraded=false

### en-tech — 英文技术

查询：`postgres logical replication lag`

英文技术主题，覆盖面广。

| 源 | 类型 | HTTP | 状态 | 原始条数 | 去重后 | 返回条数 | 有效 URL | 有效唯一 | 返回重复率 | 原始重复率 | 服务端 ms | 客户端 ms | 失败码 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hn-live | hackernews | 200 | completed | 13 | 12 | 10 | 10 | 10 | 0.0% | 7.7% | 1331 | 1346 | — |
| **全源融合** | — | 200 | completed | 13 | 12 | 10 | 10 | 10 | 0.0% | 7.7% | 1391 | 1395 | — |

融合状态：partial=false，failedSources=[]，degraded=false

融合后前 5 条 URL（顺序即服务端排序）：
1. https://github.com/kuvasz-io/kuvasz-streamer
2. https://github.com/pgdogdev/pgdog
3. https://xata.io/blog/pgstream-postgres-replication-schema-changes
4. https://github.com/mkleczek/pgwrh
5. https://github.com/PgOutput2Json/PgFreshCache

### exact-term — 精确关键词

查询：`"Content-Security-Policy" connect-src`

带引号的精确短语，用于观察分词/短语匹配行为。

| 源 | 类型 | HTTP | 状态 | 原始条数 | 去重后 | 返回条数 | 有效 URL | 有效唯一 | 返回重复率 | 原始重复率 | 服务端 ms | 客户端 ms | 失败码 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hn-live | hackernews | 200 | completed | 2 | 2 | 2 | 2 | 2 | 0.0% | 0.0% | 774 | 776 | — |
| **全源融合** | — | 200 | completed | 2 | 2 | 2 | 2 | 2 | 0.0% | 0.0% | 505 | 509 | — |

融合状态：partial=false，failedSources=[]，degraded=false

融合后前 5 条 URL（顺序即服务端排序）：
1. https://news.ycombinator.com/item?id=45064867
2. https://news.ycombinator.com/item?id=5365008

### fresh — 新近内容

查询：`openai api changelog`，freshness=`week`

带 freshness=week，仅近 7 天；不支持时间过滤的源会返回更旧内容。

| 源 | 类型 | HTTP | 状态 | 原始条数 | 去重后 | 返回条数 | 有效 URL | 有效唯一 | 返回重复率 | 原始重复率 | 服务端 ms | 客户端 ms | 失败码 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hn-live | hackernews | 200 | completed | 0 | 0 | 0 | 0 | 0 | 0.0% | n/a | 503 | 509 | — |
| **全源融合** | — | 200 | completed | 0 | 0 | 0 | 0 | 0 | 0.0% | n/a | 471 | 474 | — |

融合状态：partial=false，failedSources=[]，degraded=false

## 4. 逐源汇总（跨全部 query）

| 源 | 请求 | 成功 | 失败 | 原始条数合计 | 去重后合计 | 返回条数合计 | 有效 URL 合计 | 平均服务端 ms | 平均客户端 ms | 失败码 |
|---|---|---|---|---|---|---|---|---|---|---|
| hn-live | 4 | 4 | 0 | 15 | 14 | 12 | 12 | 1038 | 1045 | — |

## 5. 口径与限制

- 有效 URL：形如 `^https?://` 且主机名不是 `example.com`（含子域）。Mock 源全部产出 `example.com` 合成 URL，不计为有效搜索结果。
- 返回重复率：返回行中重复 URL / 返回 URL 总数。引擎在返回前已去重，正常应为 0；非 0 属缺陷。
- 原始重复率：`(rawCount - dedupedCount) / rawCount`，反映该源自身返回的重复程度。
- 延迟：服务端 `stats.timing.totalMs` 与客户端 wall time 都记录；两者差值为传输与 JSON 序列化开销。
- 未做主观相关性评分：判断「哪条结果更相关」需要人工标注或外部标注集，本脚本不提供，也不以 LLM 自评代替。
- 单一源的结果只能说明该源自身表现；不同源的索引范围不同（例如技术社区 vs 通用网页），横向比较条数没有质量含义。

## 6. 如何读这份报告（必读）

1. **条数不是质量分**。本报告没有相关性评测集，`returnedCount` / `validUrlCount` 只说明该源「返回了多少可用 URL」，不说明「这些 URL 有多相关」。
2. **Hacker News 是技术社区垂直检索，不是通用网页搜索**。它对英文技术主题有覆盖，对中文时事（如 zh-news）通常返回 0 条——这是索引范围的必然结果，不是缺陷，也不能因此得出「某源更好 / 更差」的排名。
3. **跨源条数不可比**。不同源的结果上限、去重策略、是否支持 `freshness` 都不同；只有在同一 query、同一 `limit`、同一时刻下的同一源自比才有意义。
4. **本轮参与统计的真实源只有 1 个**（hn-live）。样本量与源数量都不足以支撑任何「质量最好」的结论。
5. 需要「哪条更相关」的判断时，必须引入人工标注的相关性评测集（或外部 ground truth），本脚本不提供、也不冒充提供。

