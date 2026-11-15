# v0.1.4 Provider 配置能力矩阵

日期：2026-11-15 ｜ 状态：**代码与契约测试完成，真实联调待凭证**

> 判定口径：`documented` = 按官方文档实现且有本地契约测试；`live_tested` = 有真实调用记录。
> 本轮**没有任何 Provider 升到 `live_tested`**，因为没有任何真实凭证。

## 第一批：原生搜索 Provider（已实现）

| Type | 官方文档 | 真实端点 | 鉴权 | Web 表单字段 | 可无 Key | 状态 |
|---|---|---|---|---|---|---|
| `tencent-yuanbao` | [腾讯云 SearchPro](https://cloud.tencent.com/document/product/1806/121811) | `POST https://wsa.tencentcloudapi.com/` | TC3-HMAC-SHA256，SecretId + SecretKey | SecretId、SecretKey、搜索模式、垂直领域、站点过滤 | 否 | documented |
| `doubao` | [火山联网搜索](https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh) | `POST https://open.feedcoopapi.com/search_api/web_search` | Bearer | 限定站点、屏蔽站点、Query 改写 | 否 | documented |
| `deepseek-search` | [DeepSeek Search](https://api-docs.deepseek.com/zh-cn/guides/search/) | `POST https://api.deepseek.com/v1/tools/search` | Bearer | 返回正文开关 | 否 | documented |
| `qianfan-search` | [百度千帆 AI 搜索](https://cloud.baidu.com/doc/qianfan-api/s/Jmwbl4qxs) | `POST https://qianfan.baidubce.com/v2/ai_search/web_search` | Bearer | 版本（standard/turbo/pro）、限定站点 | 否 | documented |
| `anysearch` | [anysearch-skill](https://github.com/anysearch-ai/anysearch-skill) | `POST https://api.anysearch.com/v1/search` | 可选 Bearer | 垂直标签、区域偏好 | **是**（匿名限流更严） | documented |

### 各 Provider 的协议要点（已核对）

- **腾讯元宝**：`Response.Pages` 是 **JSON 字符串数组**，需二次解析；`Cnt` 只接受 10/20/30/40/50；`Freshness` 用 `dN/mN/yN` 或日期区间。凭证是**一对**，存为一个 JSON 字符串整体轮换。
- **豆包**：字段全部 **PascalCase**；`Result` 失败时为 `null`，错误在 `ResponseMetadata.Error`；10406/10408/10409/10410/10412 是额度问题。
- **DeepSeek**：独立 Search API，不是 Chat Completion；402 是余额不足。
- **千帆**：真实网页在 `references[]`，图片类型会被过滤；`messages` 仅单轮。
- **AnySearch**：`{code,data:{results[]}}`，`code !== 0` 即失败；匿名与带 Key 的限流不同。

## 第二批：AI 联网 Provider（已实现 5 个）

| Type | 官方文档 | 端点 | 能力 | 引用来源 | 状态 |
|---|---|---|---|---|---|
| `gemini` | [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) | `POST /v1beta/models/{model}:generateContent`，`x-goog-api-key` | grounded_answer | `groundingMetadata.groundingChunks[].web.{uri,title}` | documented |
| `grok` | [xAI Web Search](https://docs.x.ai/developers/tools/web-search) | `POST /v1/responses`，`tools:[{type:"web_search"}]` | grounded_answer | `annotations[type=url_citation]` + `web_search_call.action.sources` | documented |
| `mimo` | [MiMo OpenAI Chat](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post) | `POST /v1/chat/completions`，`tools:[{type:"web_search",...}]` | grounded_answer | `message.annotations[].web_search tool call` | documented |
| `bailian` | [百炼联网搜索](https://help.aliyun.com/zh/model-studio/web-search) | `POST /api/v1/services/aigc/text-generation/generation` | grounded_answer | `output.search_info.search_results[]` | documented |
| `stepfun` | [阶跃网页搜索](https://platform.stepfun.com/docs/zh/api-reference/Search/search) | `POST /v1/search` | **raw_search** | `results[]` | documented |

### 协议要点（都能改变实现对不对）

- **Gemini**：当前文档里 `google_search` 是唯一正确工具；`google_search_retrieval` 只给旧模型。模型 ID 默认 `gemini-3.8-flash`，必须可改（Google 下线很快）。
- **Grok**：`web_search` 可用 ≠ 真的用了。必须检查 `output[]` 里有没有 `web_search_call`，否则 `toolInvoked=false`。`allowed_domains` 与 `excluded_domains` 互斥且各限 5 个。
- **MiMo**：`tools[]` 里的 `type` 字面量是 `web_search`，**不是** function 工具；`force_search`/`max_keyword`/`limit` 是它的参数。需先在小米控制台开通联网插件。
- **百炼**：**OpenAI 兼容通道拿不到来源**，必须走 DashScope 原生 `text-generation/generation`，`result_format=message` + `enable_source=true`；`baseUrl` 是 `https://{WorkspaceId}.{region}.maas.aliyuncs.com`，不能硬编码地域。
- **阶跃**：文档明确 `step-5-preview` 等不支持 Chat Completions 内置 `web_search`，独立 `/v1/search` 才是官方路径，所以它是 `raw_search` 而不是 grounded。

### 仍未实现

| Type | 原因 |
|---|---|
| `minimax` | 官方 web_search 仅以 **stdio MCP（uvx minimax-coding-plan-mcp）** 形式提供；浏览器用户注入本机命令属于不可接受的风险，需要单独的受信任执行方案。 |
| `metaso` | 只核实到路径与查询参数，host/鉴权/响应结构未证实。 |

这两个保持 `planned`，不能创建；`metaso` 可用 `generic-http` 自行接入。

## 第三批：兼容网关与长尾

| 类型 | 建议接入方式 | 状态 |
|---|---|---|
| DuckDuckGo | 无官方通用 API；仅 Instant Answer | 不可创建 |
| 秘塔 | 官方页面仅有 `POST /api/v1/search` 与 q/scope/size/page，host/鉴权/响应未核实 | 不可创建 |
| Search Gateway / 其他自建网关 | `generic-http` 声明式映射 | 可用 |
| Generic MCP | 远程 Streamable HTTP（计划） | **未实现** |

## 能力分离

- `raw_search`：返回可验证网页结果（第一批全部属于此类）。
- `grounded_answer`：返回模型回答 + `citations[]` + `toolInvoked`。**本轮无此类 Provider 实现**，但契约、REST/MCP 通道与实验台展示已就绪。

## 凭证安全

- 所有凭证经现有 Key Scheduler 加密存储，界面只显示首 4 + 末 4。
- 腾讯凭证对以一个 JSON 字符串存储，轮换原子化，禁止两个字段独立组合。
- 测试失败信息经过 `redactSecrets`，不包含明文。

## 联网状态与来源（本轮修正）

`GroundedAnswer.status` 把「联网」拆成五个独立事实，任何一个都可能是 `unknown`：

| 字段 | 含义 | 证据来源 |
|---|---|---|
| `toolProvided` | 请求里带了联网工具 | 请求体（恒为 true） |
| `toolInvoked` | 模型真的调用了工具 | Gemini `groundingMetadata`；Grok `web_search_call`；MiMo `annotations`；百炼 `usage.plugins.search.count` |
| `retrievalSucceeded` | 调用返回了可用内容 | chunk / result / source 数量 |
| `hasVerifiableSources` | 至少一条 http(s) 引用 | 引用 URL 校验 |
| `answerSupported` | 回答与来源有厂商级绑定 | Gemini `groundingSupports`；Grok `url_citation`；百炼 `[ref_N]` 标记 |

**为什么 `unknown` 很重要**：Gemini 在没有 `groundingMetadata` 时不说明「没搜」还是「搜了但没元数据」；
百炼在既无 `usage.plugins` 也无 `search_info` 时不说明是否联网。这些情况返回 `unknown`，
UI 显示为未验证，**不会**被当作搜索成功。

**排名不是来源**：StepFun 的 `position` 现在写入 `upstreamRank`。此前它被写进
`upstream.providerName`，界面因此显示「来源：rank 1」——这是伪造来源。

**Google Search Suggestions**：官方要求展示，但我们只取 `{label, url}` 纯数据，
厂商 HTML 一律丢弃（`vendorHtmlWithheld=true`），前端用自己的元素渲染。
`groundingSupports` 的下标与 `groundingChunks` 一一对应，因此引用按厂商顺序保留、
不去重；去重会让所有下标错位。

## 账户级额度（多 Key 不等于多账户）

| 配置项 | 位置 | 说明 |
|---|---|---|
| `accountGroup` | Provider 配置 | 同一厂商账户共用此名字 |
| `accountRpmLimit` | Provider 配置 | 整个账户组每分钟请求数，0 = 不限制 |
| `accountDailyQuota` | Provider 配置 | 整个账户组每日请求数，留空 = 不限制 |

- 预算在**取 Key 槽位之前**扣减；取不到 Key 时会退回。
- 账户预算耗尽返回 `quota_exceeded`（而不是 `no_available_key`），因为换一把同账户的 Key 也无济于事。
- **仅限单进程**：多副本各自计数。这不是分布式协调，文档与 UI 都明确说明。
- 界面位置：Provider 表单「账户级额度（多 Key 共用）」。
