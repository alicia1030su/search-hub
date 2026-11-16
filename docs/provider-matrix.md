# Provider matrix

One table for every provider type the catalog knows about: what it is, what it needs,
and — the part that matters — **what evidence is still missing before it can be called
`live_tested`**.

**This file is generated.** Run `node scripts/generate-provider-matrix.mjs` after any
catalog change; CI runs it with `--check` and fails on drift, so the counts below can
never quietly disagree with the code again.

## Counts (derived, not typed by hand)

| Metric | Value |
|---|---|
| Catalogue entries | 58 |
| Native adapters (`builtin`) | 50 |
| `live_tested` (real vendor call recorded) | 4 |
| `documented` (implemented, never called the vendor) | 45 |
| `mock_verified` (contract-tested against a local double only) | 1 |
| Generic presets (`generic`) | 7 |
| No official API (`unavailable`) | 1 |
| Adapters registered | 50 |

These four states are **not** interchangeable:

| Level | Meaning |
|---|---|
| `live_tested` | A recorded run against the real vendor API returned real results. Evidence lives in `docs/live-evidence/<type>.json`. |
| `documented` | Implemented strictly from the vendor's official documentation and covered by local contract tests. The wire shape is believed correct; the account, quota and live behaviour are unverified. |
| `mock_verified` | Exercised only against a deterministic local double. Proves the code path, never the vendor. |
| `unverified` | No adapter, or an adapter whose vendor interface could not be confirmed. |

Contract tests use local HTTP fixtures built from the documented wire format. They
prove protocol fidelity, **not** that a key works.

## Implemented providers

| Type | Capability | Category | Auth | Default URL | Verification | Notes |
|---|---|---|---|---|---|---|
| `brave` | raw_search | general | api_key | https://api.search.brave.com | `documented` | 适配器按官方 Web Search API 文档实现（count 1–20、offset 0–9）。目标结果超过 20 时按 offset 自动翻页，最多 10 页 200 条，并受 maxRequestsPerSearch 预算约束；上游返回不足时如实报告实际条数与消耗的请求数。无订阅 Key 且 api.search.brave.com 在当前开发网络不可达，未联调。 |
| `searxng` | raw_search | general | none | — | `documented` | 必须由用户提供自建实例地址；许多公共实例禁用了 JSON 格式；当前没有可用实例，未联调。 |
| `hackernews` | raw_search | general | none | https://hn.algolia.com | `live_tested` | v0.1.1 已在真实网络环境完成联调，用于验证完整搜索链路；不用于宣称通用网页搜索能力。 |
| `generic-http` | raw_search | custom | api_key | — | `documented` | 仅支持声明式映射，不执行任意代码。 |
| `search-hub-legacy` | raw_search | compat | api_key | http://127.0.0.1:44475 | `documented` | 兼容适配器，目前只实现 REST（transport 仅接受 rest），未核实真实 44475 的协议；path/mode 可配置，未实现 MCP。只读调用，不修改/迁移/写入旧服务，删除实例即可完全撤销。容器内 127.0.0.1 指容器自身，宿主机请用 host.docker.internal 或网关 IP，跨服务器用可达地址；目标需加入私有主机白名单。未连接真实旧实例，测试使用本地 fake。 |
| `mock` | raw_search | custom | none | — | `mock_verified` | 这是内置测试替身（mock），不发起任何网络请求，因此不能算作真实厂商联调（live_tested）。仅用于测试与演示，不代表真实搜索能力。 |
| `minimax` | raw_search | ai | bearer | https://api.minimaxi.com | `documented` | 协议取自官方 MCP 源码（minimax_mcp/server.py + client.py）：POST {host}/v1/coding_plan/search，body {"q": query}，头 Authorization: Bearer 与 MM-API-Source: Minimax-MCP。HTTP 200 也可能业务失败，因此按 base_resp.status_code 判定：1004 = 密钥无效或密钥与 host |
| `metaso` | raw_search | general | bearer | https://metaso.cn | `documented` | 官方控制台路径 POST https://metaso.cn/api/v1/search；未带 Key 探测返回 HTTP 200 + {"errCode":2005,"errMsg":"API密钥无效"}，因此业务状态在响应体而不是 HTTP 状态码。鉴权 Authorization: Bearer。参数 q/scope/size/page，size 按官方示例以字符串发送。默认 scope=webpage；改成 document/s |
| `metaso-mcp` | raw_search | compat | none | — | `documented` | 复用 Generic MCP 客户端（Streamable HTTP），按秘塔约定预置：参数模板 {"q":"{{query}}","size":{{limit}}}、结果路径 webpages、字段 title/link/snippet/date。地址可改为任意远程 MCP 端点。不会主动连接或探测任何旧实例，未联调。 |
| `duckduckgo` | raw_search | general | none | https://api.duckduckgo.com | `documented` | 官方 API 只提供 Instant Answer（AbstractText/AbstractURL/RelatedTopics/Results），不是通用网页搜索；HTML 抓取违反其条款，本项目不做。适配器把即时答案与其链接作为结果返回，并在 warnings 里明确说明它不是网页搜索。需要真正的 DuckDuckGo 网页结果请用合规网关 + Generic HTTP。本机不可达，未联调。 |
| `exa` | raw_search | general | api_key | https://api.exa.ai | `documented` | 官方文档已核对（2026-11-15）：POST /search，x-api-key 鉴权，numResults 1–100，type 支持 auto/lite/deep 等，includeDomains/excludeDomains 各上限 1200，startPublishedDate 控制时效。/search 无 offset，因此单次请求最多 100 条，超过部分在 UI 侧提示而不是偷偷截断。响应含 costDollars，适 |
| `firecrawl` | raw_search | general | api_key | https://api.firecrawl.dev | `documented` | 官方文档已核对（2026-11-15）：POST /v2/search，Authorization: Bearer fc-…，响应 {success,data:{web[],news[],images[]}}，web 项含 url/title/description/position。无 offset/page 参数，单次最多 100 条；github 分类已下线（返回 400），改用 developer。无真实 Key，未联调。 |
| `serper` | raw_search | general | api_key | https://google.serper.dev | `documented` | 官方文档与实时响应结构已核对（2026-11-15）：POST /search，X-API-KEY 鉴权，num ≤100，page 从 1 开始，gl/hl 控制地域语言，tbs 控制时效。适配器只把 organic[] 作为网页结果；answerBox/knowledgeGraph 是 SERP 特性，不会伪造成网页。配置 targetResults 超过 num 时按 page 自动翻页，受 maxRequestsPerSearc |
| `github` | raw_search | vertical | api_key | https://api.github.com | `documented` | 官方文档已核对（2026-11-15）：GET /search/{repositories\|issues\|code}，per_page ≤100，page 从 1 开始；Token 可选，未认证时限制 10 次/分钟。垂直索引，不代表通用网页搜索。无 Token，未联调。 |
| `arxiv` | raw_search | vertical | none | https://export.arxiv.org | `documented` | 官方文档已核对（2026-11-15）：GET /api/query，search_query=all:…（可用 cat: 限定分类），max_results ≤100，无需鉴权；arXiv 要求请求间隔 ≥3 秒，本适配器每次搜索只发一次请求。响应为 Atom XML，适配器用严格字段提取而非通用解析。学术索引，不覆盖全网；无真实调用记录。 |
| `perplexity-search` | raw_search | general | api_key | https://api.perplexity.ai | `documented` | 官方检索接口与 Sonar 对话产品是两套协议；本项只做 raw_search，AI 回答见 perplexity-sonar。max_results 上限 20。本机 api.perplexity.ai 不可达，无真实 Key，未联调。 |
| `youcom` | raw_search | general | api_key | https://ydc-index.io | `documented` | 官方文档：GET /v1/search，X-API-Key 鉴权，results.web[] 与 results.news[] 分开；只把 web[] 作为网页结果。开发期该 host 返回 402（需付费账户），确认路径但未取得响应体；无真实 Key，未联调。 |
| `jina-search` | raw_search | general | api_key | https://s.jina.ai | `documented` | 官方文档：GET /{query}，Accept: application/json 或 X-Respond-With: no-content 取 JSON；data[] 含 title/url/description/content。返回页面内容而非 SERP 排名，因此不写 upstreamRank。本机 s.jina.ai 不可达，未联调。 |
| `parallel-search` | raw_search | general | api_key | https://api.parallel.ai | `documented` | 官方文档：POST /v1beta/search，x-api-key 鉴权，body 支持 objective / search_queries / max_results / source_policy.include_domains。开发期返回 401，确认路径；无真实 Key，未联调。 |
| `linkup-search` | raw_search | general | api_key | https://api.linkup.so | `documented` | 官方文档：POST /v1/search，Bearer 鉴权，body 含 q / depth(standard\|deep) / outputType。本适配器固定 outputType=searchResults，避免把 sourcedAnswer 混进网页结果。无真实 Key，未联调。 |
| `serpapi` | raw_search | general | api_key | https://serpapi.com | `documented` | 官方文档：GET /search.json，api_key 为查询参数（不是 Bearer）；organic_results[] 含 title/link/snippet/position/date；answer_box 与 knowledge_graph 属 SERP 特性，不伪造成网页。start 0 基偏移、num ≤100。无真实 Key，未联调。 |
| `searchapi` | raw_search | general | api_key | https://www.searchapi.io | `documented` | 官方文档：GET /api/v1/search，api_key 查询参数，organic_results[] 含 title/link/snippet/position/date；page 从 1 开始、num ≤100。开发期返回 401，确认路径。无真实 Key，未联调。 |
| `dataforseo` | raw_search | general | basic | https://api.dataforseo.com | `documented` | 官方文档：POST /v3/serp/google/organic/live/advanced，Basic base64(login:password) 鉴权（不支持 Bearer），body 为任务数组，depth 10-700。凭证请填 login:password。无真实凭证，未联调。 |
| `openai-websearch` | grounded_answer | ai | api_key | https://api.openai.com | `documented` | 官方文档：POST /v1/responses，tools:[{type:'web_search'}]；output[] 中 web_search_call 表示工具实际被调用，message.content[].annotations[type=url_citation] 才是可验证来源。没有 web_search_call 时 toolInvoked=false。无真实 Key，未联调。 |
| `anthropic-websearch` | grounded_answer | ai | api_key | https://api.anthropic.com | `documented` | 官方文档：POST /v1/messages，x-api-key + anthropic-version: 2023-06-01，tools:[{type:'web_search_20250305',name:'web_search',max_uses}]；server_tool_use 表示调用发生，web_search_tool_result 含 url/title/page_age，text 块的 citations 为文本锚定来 |
| `mistral-websearch` | grounded_answer | ai | api_key | https://api.mistral.ai | `documented` | 官方文档：POST /v1/conversations，Bearer 鉴权，tools:[{type:'web_search'}]。Mistral 未公开稳定的 tool 调用标记与文本到来源映射，因此 toolInvoked/answerSupported 在缺少证据时为 unknown。无真实 Key，未联调。 |
| `perplexity-sonar` | grounded_answer | ai | api_key | https://api.perplexity.ai | `documented` | 官方文档：POST /chat/completions，model 为 sonar/sonar-pro；响应含 choices[0].message.content、citations[]（URL 列表）与 search_results[]（title/url/date）。与 perplexity-search 是两套协议，不合并。无真实 Key，未联调。 |
| `naver` | raw_search | general | api_key | https://openapi.naver.com | `documented` | 官方文档：GET /v1/search/{webkr\|news\|blog\|kin}，需 X-Naver-Client-Id 与 X-Naver-Client-Secret 两个头；凭证填 client_id:client_secret。display ≤100、start ≤1000。返回 title 含 <b> 高亮，适配器已剥离标签。开发期返回 401，确认路径；无真实凭证，未联调。 |
| `kakao` | raw_search | general | api_key | https://dapi.kakao.com | `documented` | 官方文档：GET /v2/search/{web\|blog\|cafe\|book}，Authorization: KakaoAK <key>，size ≤50、page 1 基，meta.is_end 表示是否到底。本机 dapi.kakao.com 不可达，无真实 Key，未联调。 |
| `yandex` | raw_search | general | api_key | https://searchapi.api.cloud.yandex.net | `documented` | 官方文档：POST /v2/web/search，Authorization: Api-Key <secret>，query.search_web{query_text,page,docs_on_page}；响应 results[] 含 title/url/passages。未使用旧 XML 接口（已被 v2 取代）。本机该 host 不可达，无真实 Key，未联调。 |
| `wikipedia` | raw_search | vertical | none | https://en.wikipedia.org | `documented` | 官方文档：GET /w/api.php?action=query&list=search&format=json；无需鉴权，但 Wikimedia 要求带描述性 User-Agent。返回条目而非网页排名，界面会标注为垂直索引。本机 en.wikipedia.org 不可达，未联调。 |
| `crossref` | raw_search | vertical | none | https://api.crossref.org | `live_tested` | 官方文档：GET /works?query=…&rows=…；无需鉴权，建议带 mailto 进入 polite pool。message.items[] 含 title[]/URL/DOI/abstract/published；无 URL 时回退到 doi.org 解析地址。已用公开接口真实联调（2026-11-15，真实 HTTP 调用返回结果）。 |
| `openalex` | raw_search | vertical | none | https://api.openalex.org | `live_tested` | 官方文档：GET /works?search=…&per-page=…；无需鉴权。abstract_inverted_index 是词到位置的映射，适配器重建为文本（直接返回映射会把 JSON 当摘要）。已用公开接口真实联调（2026-11-15，真实 HTTP 调用返回结果）。 |
| `pubmed` | raw_search | vertical | none | https://eutils.ncbi.nlm.nih.gov | `live_tested` | 官方文档：esearch.fcgi 得到 idlist，esummary.fcgi 得到标题/期刊/作者/日期；无需鉴权，NCBI 要求每秒不超过 3 次并带 tool/email。已用公开接口真实联调（2026-11-15，真实 HTTP 调用返回结果）。 |
| `semanticscholar` | raw_search | vertical | api_key | https://api.semanticscholar.org | `documented` | 官方文档：GET /graph/v1/paper/search?query=…&limit=…&fields=…；x-api-key 可选但能提高额度。开发期返回 429（共享池限流），确认路径；无真实 Key，未联调。 |
| `europepmc` | raw_search | vertical | none | https://www.ebi.ac.uk | `documented` | 官方文档：GET /europepmc/webservices/rest/search?query=…&format=json&pageSize=…&resultType=core；无需鉴权。本机该 host 不可达，未联调。 |
| `gdelt` | raw_search | vertical | none | https://api.gdeltproject.org | `documented` | 官方文档：GET /api/v2/doc/doc?query=…&mode=ArtList&format=json&maxrecords=…&sort=DateDesc&timespan=…；无需鉴权，限流较严（开发期返回 429）。seendate 为 YYYYMMDDTHHMMSSZ，适配器转 ISO。新闻索引，不等于全网网页。 |
| `generic-mcp` | raw_search | compat | bearer | — | `documented` | 实现 MCP Streamable HTTP：initialize → notifications/initialized → tools/list → tools/call。只支持远程 http(s)，**不提供 stdio**——网页用户不能借此让服务器执行本地命令。endpoint 经 SafeFetch 校验（SSRF、重定向、超时、体积上限）。tool 留空会自动挑选名称含 search/query/find 的工具；小工具集 |
| `tavily` | raw_search | general | api_key | https://api.tavily.com | `documented` | 适配器按官方 Search API 文档实现（POST /search，Authorization: Bearer；include_answer/include_raw_content 保持 false）；无真实 API Key，未联调（无效 Key 探测到 401 detail.error）。 |
| `bocha` | raw_search | general | api_key | https://api.bochaai.com | `documented` | 适配器按官方 Web Search API 文档实现（POST /v1/web-search，Authorization: Bearer）；两个域名均实测可达且返回同一错误信封：api.bochaai.com 401 (188ms) / api.bocha.cn 401 (461ms)；官方开放平台示例使用 api.bochaai.com，故默认值保持该域名，api.bocha.cn 可用 baseUrl 覆盖；无真实 API Key， |
| `anysearch` | raw_search | general | api_key | https://api.anysearch.com | `documented` | 接口契约来自官方维护的 skill 仓库（doc_spec.md + anysearch_cli.js）：POST /v1/search，max_results 1–10，匿名可用但限流更严。GET /v1/search 实测 404，确认只支持 POST。无真实 Key，未联调；匿名调用也未在本项目内实测。 |
| `gemini` | grounded_answer | ai | api_key | https://generativelanguage.googleapis.com | `documented` | 官方文档已核对（2026-11-15）：POST /v1beta/models/{model}:generateContent，x-goog-api-key 鉴权，tools:[{google_search:{}}]；引用在 candidates[0].groundingMetadata.groundingChunks[].web。默认模型 gemini-3.8-flash，可改。无真实 Key，未联调。 |
| `grok` | grounded_answer | ai | api_key | https://api.x.ai | `documented` | 官方文档已核对（2026-11-15）：POST /v1/responses，tools:[{type:'web_search'}]，include:['web_search_call.action.sources']；引用在 output[].content[].annotations[type=url_citation] 与 web_search_call.action.sources。allowed/excluded domain |
| `mimo` | grounded_answer | ai | api_key | https://api.xiaomimimo.com | `documented` | 官方文档已核对（2026-11-15）：POST /v1/chat/completions，tools:[{type:'web_search',force_search,max_keyword,limit}]（不是 function 工具）；annotations 里含 title/url/summary/site_name/publish_time。需先在小米控制台开通联网插件。默认模型 mimo-v2.6-pro。无真实 Key，未 |
| `deepseek-search` | raw_search | general | api_key | https://api.deepseek.com | `documented` | 官方文档已核对：POST /v1/tools/search，Bearer 鉴权，query 1–128 字符，count 1–50，need_content 控制正文。按成功请求计费。402=余额不足，映射为 quota 而不是 auth。无真实 Key，未联调。 |
| `doubao` | raw_search | general | api_key | https://open.feedcoopapi.com | `documented` | 官方文档已核对：POST /search_api/web_search，Bearer 鉴权，字段全部 PascalCase，结果在 Result.WebResults。Count 上限 50；Summary 为官方推荐的模型用摘要。10406/10408/10409/10410/10412 是额度问题，不是 Key 失效。无真实 Key，未联调。 |
| `tencent-yuanbao` | raw_search | general | api_key | https://wsa.tencentcloudapi.com | `documented` | 官方文档已核对（Action=SearchPro，Version=2025-05-08，Host=wsa.tencentcloudapi.com）。凭证是 SecretId+SecretKey 一对，存储为一个 JSON 字符串并整体轮换。Response.Pages 是 JSON 字符串数组，适配器会二次解析。Cnt 只接受 10/20/30/40/50。无真实凭证，未联调。 |
| `bailian` | grounded_answer | ai | api_key | — | `documented` | 官方文档已核对（2026-11-15）：OpenAI 兼容通道无法返回搜索来源，因此本适配器使用 DashScope 原生 /api/v1/services/aigc/text-generation/generation，parameters.result_format=message + enable_search + enable_source。baseUrl 必须是 https://{WorkspaceId}.{region}.m |
| `qianfan-search` | raw_search | general | api_key | https://qianfan.baidubce.com | `documented` | 官方文档已核对：POST /v2/ai_search/web_search，Bearer 鉴权；messages 仅支持单轮（取最后一条 user content）；resource_type_filter 的 web top_k 上限 50；edition 支持 standard/turbo/pro。无真实 Key，未联调。 |
| `stepfun` | raw_search | general | api_key | https://api.stepfun.com | `documented` | 官方文档已核对（2026-11-15）：POST /v1/search，query 必填，n 取 1–20，category 支持 programming/research/gov/business。文档说明 step-5-preview 等模型不支持 Chat Completions 内置 web_search，官方推荐先调本接口再把结果交给模型，因此这里是 raw_search 而不是 grounded_answer。另有远程 MC |

## Generic declarative presets

These have **no builtin adapter**: users must supply the endpoint and field mapping
through Generic HTTP/JSON. `generic` does not mean "broken" — it means "yours to
configure".

| Type | Category | Notes |
|---|---|---|
| `search-gateway` | compat | 已有私有 Search Hub 网关：通过 Generic HTTP 适配器接入，需自行填写端点与字段映射。 |
| `alt-search-gateway` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |
| `premium` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |
| `orz-fetch` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |
| `union-free` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |
| `zhihu-radar` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |
| `gpt55` | compat | 已有私有网关：通过 Generic HTTP 适配器接入。 |

## No official API

| Type | Category | Why it stays unavailable |
|---|---|---|
| `baidu` | general | 已由 qianfan-search 覆盖：POST /v2/ai_search/web_search。本条目仅作为说明保留，不可创建。 |

## Structural invariants (checked by the generator and by CI)

- A `builtin` entry without an adapter is a bug: **0** found.
- An adapter without a catalog entry is a bug (users can never create it): **0** found.
- Every `live_tested` entry must have `docs/live-evidence/<type>.json` with a recorded successful call.
