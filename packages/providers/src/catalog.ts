import type { ProviderCatalogEntry } from "@search-hub/shared";

/**
 * Honest capability catalog.
 *
 * `implementation`:
 *   builtin  - a real adapter exists in this repository
 *   generic  - works through the declarative Generic HTTP adapter (user supplies endpoint)
 *   planned  - no adapter yet; shown in the UI as planned, cannot be created
 *   unavailable - no reliable official API (documented reason below)
 *
 * `verification` is never set to "live_tested" without a recorded live run.
 * No URL below is invented: entries without a confirmed official endpoint omit
 * `docsUrl` on purpose.
 */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    type: "brave",
    name: "Brave Search",
    category: "general",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.search.brave.com",
    docsUrl: "https://api-dashboard.search.brave.com/app/documentation/web-search",
    description: "Brave 官方 Web Search API，需要订阅令牌，支持语言与时间范围过滤；单页上限 20 条、offset 最多 9 页。",
    verification: "documented",
    notes:
      "适配器按官方 Web Search API 文档实现（count 1–20、offset 0–9）。目标结果超过 20 时按 offset 自动翻页，最多 10 页 200 条，并受 maxRequestsPerSearch 预算约束；上游返回不足时如实报告实际条数与消耗的请求数。无订阅 Key 且 api.search.brave.com 在当前开发网络不可达，未联调。",
    parameters: ["targetResults", "maxPages", "maxRequestsPerSearch", "language", "region", "freshness", "safeSearch"],
    parameterLimits: {
      targetResults: { min: 1, max: 200, default: 10, pageSize: 20 },
      maxPages: { min: 1, max: 10, default: 3 },
      maxRequestsPerSearch: { min: 1, max: 10, default: 3 },
    },
    pagination: { supported: true, mode: "offset", pageSize: 20, maxPages: 10, maxResults: 200 },
    accountQuota: { scope: "account", sharedAcrossKeys: true, note: "Brave 按订阅账户计费。" },
    resultMapping: { title: "web.results[].title", url: "web.results[].url", snippet: "web.results[].description", publishedAt: "web.results[].page_age" },
  },
  {
    type: "searxng",
    name: "SearXNG",
    category: "general",
    authType: "none",
    implementation: "builtin",
    docsUrl: "https://docs.searxng.org/dev/search_api.html",
    description: "自建元搜索实例，通过 /search?format=json 获取结果。需要在实例中启用 JSON 输出。",
    verification: "documented",
    notes: "必须由用户提供自建实例地址；许多公共实例禁用了 JSON 格式；当前没有可用实例，未联调。",
  },
  {
    type: "hackernews",
    name: "Hacker News（Algolia 官方搜索 API）",
    category: "general",
    authType: "none",
    implementation: "builtin",
    defaultBaseUrl: "https://hn.algolia.com",
    docsUrl: "https://hn.algolia.com/api",
    description:
      "HN Search 官方托管 API（Algolia），无需密钥，返回真实 story/comment 链接。它是垂直技术社区搜索，不等同于通用网页搜索。",
    verification: "live_tested",
    notes: "v0.1.1 已在真实网络环境完成联调，用于验证完整搜索链路；不用于宣称通用网页搜索能力。",
  },
  {
    type: "generic-http",
    name: "通用 HTTP/JSON",
    category: "custom",
    authType: "api_key",
    implementation: "builtin",
    description: "声明式配置请求方法、路径、Headers、参数、Body、Key 注入位置与结果字段映射，无需改代码即可接入新的搜索 API。",
    verification: "documented",
    notes: "仅支持声明式映射，不执行任意代码。",
  },
  {
    type: "search-hub-legacy",
    name: "旧版 Search Hub（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "http://127.0.0.1:44475",
    description:
      "调用一个独立运行的旧版 Search Hub 的 REST 搜索接口（默认 POST /api/search），把它的结果作为本平台的一个搜索源。",
    verification: "documented",
    notes:
      "兼容适配器，目前只实现 REST（transport 仅接受 rest），未核实真实 44475 的协议；path/mode 可配置，未实现 MCP。只读调用，不修改/迁移/写入旧服务，删除实例即可完全撤销。容器内 127.0.0.1 指容器自身，宿主机请用 host.docker.internal 或网关 IP，跨服务器用可达地址；目标需加入私有主机白名单。未连接真实旧实例，测试使用本地 fake。",
  },
  {
    type: "mock",
    name: "Mock（测试用）",
    category: "custom",
    authType: "none",
    implementation: "builtin",
    description: "确定性测试源，支持延迟与故障注入，用于验证并发额度、故障隔离与融合逻辑。",
    verification: "live_tested",
    notes: "仅用于测试与演示，不代表真实搜索能力。",
  },
  {
    type: "duckduckgo",
    name: "DuckDuckGo",
    category: "general",
    authType: "none",
    implementation: "unavailable",
    docsUrl: "https://duckduckgo.com/api",
    description: "DuckDuckGo 仅提供 Instant Answer API，不提供通用网页搜索 API；HTML 抓取不稳定且不符合其使用条款。",
    verification: "no_official_api",
    notes: "不提供原生适配器。如你自有合规网关或第三方兼容服务，请用 Generic HTTP 接入，并在名称中写清实际协议来源。",
  },
  {
    type: "baidu",
    name: "百度搜索",
    category: "general",
    authType: "api_key",
    implementation: "unavailable",
    description: "百度通用网页搜索本身没有公开 API；请使用「百度千帆 AI 搜索」（qianfan-search），它提供官方的 references[] 网页结果。",
    verification: "no_official_api",
    notes: "已由 qianfan-search 覆盖：POST /v2/ai_search/web_search。本条目仅作为说明保留，不可创建。",
  },
  {
    type: "metaso",
    name: "秘塔搜索（MetaSo）",
    category: "general",
    authType: "api_key",
    implementation: "planned",
    description: "官方控制台显示 POST /api/v1/search（参数 q / scope / size / page），但完整请求域名、鉴权头与响应结构未能在本项目内核实。",
    verification: "unverified",
    notes: "已核对：官方 playground 的路径（/api/v1/search）与查询参数（q/scope/size/page）；未核实：请求 host、鉴权方式、响应字段。核实前不提供原生适配器。可用 Generic HTTP 接入：method=POST、path=/api/v1/search、keyInjection 按你的控制台说明填写（header 名需自行确认）、resultsPath 需按实际响应填写，并在搜索源名称里写清协议来源。",
  },
  {
    type: "exa",
    name: "Exa",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.exa.ai",
    docsUrl: "https://docs.exa.ai/reference/search",
    description:
      "Exa 面向 AI 的网页检索 API，返回标题、URL、发布时间、作者与页面正文摘要，支持域名过滤和发布时间窗口。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /search，x-api-key 鉴权，numResults 1–100，type 支持 auto/lite/deep 等，includeDomains/excludeDomains 各上限 1200，startPublishedDate 控制时效。/search 无 offset，因此单次请求最多 100 条，超过部分在 UI 侧提示而不是偷偷截断。响应含 costDollars，适配器会以 warning 形式告知本次计费。无真实 Key，未联调。",
    parameters: ["targetResults", "freshness", "includeDomains", "excludeDomains", "searchDepth"],
    parameterLimits: {
      targetResults: { min: 1, max: 100, default: 10 },
      searchDepth: { default: "auto" },
    },
    pagination: { supported: false, mode: "none", maxResults: 100 },
    accountQuota: { scope: "account", sharedAcrossKeys: true, note: "Exa 按账户计费与限额，多 Key 共用同一额度。" },
    resultMapping: { title: "results[].title", url: "results[].url", snippet: "results[].summary|text", publishedAt: "results[].publishedDate", score: "results[].score" },
    fields: [
      { key: "searchType", label: "检索模式", type: "select", target: "config", default: "auto", options: [
        { value: "auto", label: "auto（推荐）" },
        { value: "lite", label: "lite（低延迟低成本）" },
        { value: "deep", label: "deep（多步研究）" },
        { value: "deep-lite", label: "deep-lite" },
      ] },
      { key: "category", label: "内容分类", type: "text", target: "config", placeholder: "company / research paper / news" },
    ],
  },
  {
    type: "firecrawl",
    name: "Firecrawl Search",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.firecrawl.dev",
    docsUrl: "https://docs.firecrawl.dev/features/search",
    description:
      "Firecrawl 搜索 API：一次调用返回标题/描述/URL，可选抓取正文；支持 news/images 源与 research/developer/gov 分类。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /v2/search，Authorization: Bearer fc-…，响应 {success,data:{web[],news[],images[]}}，web 项含 url/title/description/position。无 offset/page 参数，单次最多 100 条；github 分类已下线（返回 400），改用 developer。无真实 Key，未联调。",
    parameters: ["targetResults", "includeDomains", "excludeDomains", "freshness"],
    parameterLimits: { targetResults: { min: 1, max: 100, default: 10 } },
    pagination: { supported: false, mode: "none", maxResults: 100 },
    accountQuota: { scope: "account", sharedAcrossKeys: true, note: "Firecrawl 按账户额度计费。" },
    resultMapping: { title: "data.web[].title", url: "data.web[].url", snippet: "data.web[].description" },
    fields: [
      { key: "category", label: "检索分类", type: "select", target: "config", options: [
        { value: "", label: "不限" },
        { value: "research", label: "research（学术）" },
        { value: "pdf", label: "pdf" },
        { value: "developer", label: "developer（代码/文档）" },
        { value: "gov", label: "gov（政府文件）" },
      ] },
    ],
  },
  {
    type: "serper",
    name: "Serper.dev（Google SERP）",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://google.serper.dev",
    docsUrl: "https://serper.dev/",
    description: "Serper.dev 提供的 Google 搜索结果 API：organic[] 含标题、链接、摘要与位置，支持分页与地域/语言过滤。",
    verification: "documented",
    notes:
      "官方文档与实时响应结构已核对（2026-11-15）：POST /search，X-API-KEY 鉴权，num ≤100，page 从 1 开始，gl/hl 控制地域语言，tbs 控制时效。适配器只把 organic[] 作为网页结果；answerBox/knowledgeGraph 是 SERP 特性，不会伪造成网页。配置 targetResults 超过 num 时按 page 自动翻页，受 maxRequestsPerSearch 预算约束。无真实 Key，未联调。",
    parameters: ["targetResults", "maxPages", "maxRequestsPerSearch", "language", "region", "freshness"],
    parameterLimits: {
      targetResults: { min: 1, max: 100, default: 10 },
      maxPages: { min: 1, max: 10, default: 5 },
      maxRequestsPerSearch: { min: 1, max: 10, default: 5 },
    },
    pagination: { supported: true, mode: "page", pageSize: 100, maxPages: 10, maxResults: 100 },
    accountQuota: { scope: "account", sharedAcrossKeys: true, note: "Serper 按账户计费。" },
    resultMapping: { title: "organic[].title", url: "organic[].link", snippet: "organic[].snippet", publishedAt: "organic[].date" },
    fields: [
      { key: "gl", label: "默认国家", type: "text", target: "config", placeholder: "us / cn" },
      { key: "sortBy", label: "排序", type: "text", target: "config", placeholder: "留空为相关度" },
    ],
  },
  {
    type: "github",
    name: "GitHub 搜索",
    category: "vertical",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.github.com",
    docsUrl: "https://docs.github.com/en/rest/search/search",
    description: "GitHub 官方搜索 API：仓库、Issue、代码。属于代码托管垂直索引，不覆盖全网。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：GET /search/{repositories|issues|code}，per_page ≤100，page 从 1 开始；Token 可选，未认证时限制 10 次/分钟。垂直索引，不代表通用网页搜索。无 Token，未联调。",
    parameters: ["targetResults"],
    parameterLimits: { targetResults: { min: 1, max: 100, default: 10 } },
    pagination: { supported: false, mode: "none", maxResults: 100 },
    accountQuota: { scope: "account", sharedAcrossKeys: true, note: "GitHub 按 Token/账户速率限制。" },
    resultMapping: { title: "items[].full_name", url: "items[].html_url", snippet: "items[].description", publishedAt: "items[].pushed_at" },
    fields: [
      { key: "kind", label: "检索对象", type: "select", target: "config", default: "repositories", options: [
        { value: "repositories", label: "仓库" },
        { value: "issues", label: "Issue" },
        { value: "code", label: "代码" },
      ] },
      { key: "sortBy", label: "排序", type: "select", target: "config", options: [
        { value: "", label: "最佳匹配" },
        { value: "stars", label: "星标" },
        { value: "updated", label: "更新时间" },
      ] },
    ],
  },
  {
    type: "arxiv",
    name: "arXiv",
    category: "vertical",
    capability: "raw_search",
    authType: "none",
    implementation: "builtin",
    defaultBaseUrl: "https://export.arxiv.org",
    docsUrl: "https://info.arxiv.org/help/api/index.html",
    description: "arXiv 预印本检索（Atom API）：返回标题、摘要页 URL、摘要与发布时间。学术垂直索引。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：GET /api/query，search_query=all:…（可用 cat: 限定分类），max_results ≤100，无需鉴权；arXiv 要求请求间隔 ≥3 秒，本适配器每次搜索只发一次请求。响应为 Atom XML，适配器用严格字段提取而非通用解析。学术索引，不覆盖全网；无真实调用记录。",
    parameters: ["targetResults"],
    parameterLimits: { targetResults: { min: 1, max: 100, default: 10 } },
    pagination: { supported: false, mode: "none", maxResults: 100 },
    accountQuota: { scope: "none", sharedAcrossKeys: false, note: "arXiv 无账户额度，但要求礼貌速率。" },
    resultMapping: { title: "entry.title", url: "entry.id", snippet: "entry.summary", publishedAt: "entry.published" },
    fields: [
      { key: "category", label: "分类", type: "text", target: "config", placeholder: "cs.AI / cs.CL / math.OC" },
    ],
  },
  {
    type: "tavily",
    name: "Tavily Search",
    category: "general",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.tavily.com",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    description:
      "Tavily 官方 Search API，面向 RAG/Agent 设计，返回 title/url/content/score/published_date，支持 general/news 主题与时间范围。",
    verification: "documented",
    notes:
      "适配器按官方 Search API 文档实现（POST /search，Authorization: Bearer；include_answer/include_raw_content 保持 false）；无真实 API Key，未联调（无效 Key 探测到 401 detail.error）。",
  },
  {
    type: "bocha",
    name: "博查（Bocha）",
    category: "general",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.bochaai.com",
    docsUrl: "https://bocha-ai.feishu.cn/wiki/RXEOw02rFiwzGSkd9mUcqoeAnNK",
    description:
      "博查官方 Web Search API，中文网页覆盖较好，响应兼容 Bing Search 结构（data.webPages.value[]），支持 freshness 时间筛选。",
    verification: "documented",
    notes:
      "适配器按官方 Web Search API 文档实现（POST /v1/web-search，Authorization: Bearer）；两个域名均实测可达且返回同一错误信封：api.bochaai.com 401 (188ms) / api.bocha.cn 401 (461ms)；官方开放平台示例使用 api.bochaai.com，故默认值保持该域名，api.bocha.cn 可用 baseUrl 覆盖；无真实 API Key，未联调。",
  },
  {
    type: "anysearch",
    name: "AnySearch",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.anysearch.com",
    docsUrl: "https://github.com/anysearch-ai/anysearch-skill",
    description:
      "AnySearch 统一实时搜索：支持匿名与 Bearer Key 两种模式，返回 title/url/content/snippet。",
    verification: "documented",
    notes:
      "接口契约来自官方维护的 skill 仓库（doc_spec.md + anysearch_cli.js）：POST /v1/search，max_results 1–10，匿名可用但限流更严。GET /v1/search 实测 404，确认只支持 POST。无真实 Key，未联调；匿名调用也未在本项目内实测。",
    fields: [
      { key: "tag", label: "垂直标签", type: "text", target: "config", placeholder: "finance.quote", help: "留空为通用网页搜索。" },
      { key: "zone", label: "区域偏好", type: "select", target: "config", options: [
        { value: "", label: "不指定" },
        { value: "cn", label: "中国" },
        { value: "intl", label: "国际" },
      ] },
    ],
  },
  {
    type: "gemini",
    name: "Google Gemini（搜索 grounding）",
    category: "ai",
    capability: "grounded_answer",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    docsUrl: "https://ai.google.dev/gemini-api/docs/google-search",
    description:
      "Gemini generateContent + google_search 工具：返回模型回答与 groundingChunks 引用（uri/title），可判断是否真的联网。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /v1beta/models/{model}:generateContent，x-goog-api-key 鉴权，tools:[{google_search:{}}]；引用在 candidates[0].groundingMetadata.groundingChunks[].web。默认模型 gemini-3.8-flash，可改。无真实 Key，未联调。",
    fields: [
      { key: "model", label: "Model ID", type: "text", target: "model", required: true, placeholder: "gemini-3.8-flash", help: "Google 会下线旧模型；以官方模型页为准。" },
    ],
  },
  {
    type: "grok",
    name: "xAI Grok（web_search）",
    category: "ai",
    capability: "grounded_answer",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.x.ai",
    docsUrl: "https://docs.x.ai/developers/tools/web-search",
    description:
      "xAI Responses API + web_search 服务端工具：返回回答与 url_citation 注解，并能判断是否真的触发 web_search_call。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /v1/responses，tools:[{type:'web_search'}]，include:['web_search_call.action.sources']；引用在 output[].content[].annotations[type=url_citation] 与 web_search_call.action.sources。allowed/excluded domains 互斥且各限 5 个。默认模型 grok-4.7。无真实 Key，未联调。",
    fields: [
      { key: "model", label: "Model ID", type: "text", target: "model", required: true, placeholder: "grok-4.7" },
      { key: "allowedDomains", label: "限定域名", type: "text", target: "config", placeholder: "docs.x.ai,python.org", help: "最多 5 个，与排除域名互斥。" },
      { key: "excludedDomains", label: "排除域名", type: "text", target: "config", placeholder: "example.com", help: "最多 5 个。" },
    ],
  },
  {
    type: "minimax",
    name: "MiniMax",
    category: "ai",
    authType: "api_key",
    implementation: "planned",
    docsUrl: "https://platform.minimaxi.com",
    description: "目标兼容源。需确认其联网搜索/Agent 接口的具体形态。",
    verification: "unverified",
  },
  {
    type: "mimo",
    name: "小米 MiMo（web_search）",
    category: "ai",
    capability: "grounded_answer",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.xiaomimimo.com",
    docsUrl: "https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post",
    description:
      "MiMo Chat Completions + web_search 工具：引用在 message.annotations[].web_search tool call。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /v1/chat/completions，tools:[{type:'web_search',force_search,max_keyword,limit}]（不是 function 工具）；annotations 里含 title/url/summary/site_name/publish_time。需先在小米控制台开通联网插件。默认模型 mimo-v2.6-pro。无真实 Key，未联调。",
    fields: [
      { key: "model", label: "Model ID", type: "text", target: "model", required: true, placeholder: "mimo-v2.6-pro" },
      { key: "forceSearch", label: "强制联网", type: "boolean", target: "config", default: false, help: "关闭时由模型判断是否需要搜索。" },
      { key: "maxKeyword", label: "最大关键词数", type: "number", target: "config", default: 5, min: 1, max: 50 },
      { key: "searchLimit", label: "单次结果条数", type: "number", target: "config", default: 5, min: 1, max: 50 },
    ],
  },
  {
    type: "deepseek-search",
    name: "DeepSeek Search",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/guides/search/",
    description:
      "DeepSeek 独立结构化搜索接口（非 Chat Completion）：返回 title/url/snippet/summary/content/site_name/date/rerank_score。",
    verification: "documented",
    notes:
      "官方文档已核对：POST /v1/tools/search，Bearer 鉴权，query 1–128 字符，count 1–50，need_content 控制正文。按成功请求计费。402=余额不足，映射为 quota 而不是 auth。无真实 Key，未联调。",
    fields: [
      { key: "needContent", label: "返回网页正文", type: "boolean", target: "config", default: false, help: "开启后 content 字段返回正文，响应会变大。" },
    ],
  },
  {
    type: "doubao",
    name: "豆包搜索（火山联网）",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://open.feedcoopapi.com",
    docsUrl: "https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh",
    description:
      "火山引擎豆包联网搜索 Custom 版：返回 Title/Url/Summary/Snippet/SiteName/PublishTime，字段为大驼峰。",
    verification: "documented",
    notes:
      "官方文档已核对：POST /search_api/web_search，Bearer 鉴权，字段全部 PascalCase，结果在 Result.WebResults。Count 上限 50；Summary 为官方推荐的模型用摘要。10406/10408/10409/10410/10412 是额度问题，不是 Key 失效。无真实 Key，未联调。",
    fields: [
      { key: "sites", label: "限定站点", type: "text", target: "config", placeholder: "aliyun.com|mp.qq.com", help: "最多 20 个，用 | 分隔，需完整域名。" },
      { key: "blockHosts", label: "屏蔽站点", type: "text", target: "config", placeholder: "example.com", help: "最多 5 个，用 | 分隔。" },
      { key: "queryRewrite", label: "开启 Query 改写", type: "boolean", target: "config", default: false, help: "会增加搜索耗时。" },
    ],
  },
  {
    type: "tencent-yuanbao",
    name: "腾讯元宝搜索",
    category: "general",
    capability: "raw_search",
    credentialKind: "pair",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://wsa.tencentcloudapi.com",
    docsUrl: "https://cloud.tencent.com/document/product/1806/121811",
    description:
      "腾讯云元宝搜索 SearchPro：全网公开资源 + 腾讯内容生态，返回标题、发布时间、URL、摘要、站点与权威度。使用 TC3-HMAC-SHA256 签名。",
    verification: "documented",
    notes:
      "官方文档已核对（Action=SearchPro，Version=2025-05-08，Host=wsa.tencentcloudapi.com）。凭证是 SecretId+SecretKey 一对，存储为一个 JSON 字符串并整体轮换。Response.Pages 是 JSON 字符串数组，适配器会二次解析。Cnt 只接受 10/20/30/40/50。无真实凭证，未联调。",
    fields: [
      { key: "secretId", label: "SecretId", type: "text", required: true, target: "credential", placeholder: "SecretId" },
      { key: "secretKey", label: "SecretKey", type: "password", required: true, target: "credential" },
      { key: "mode", label: "搜索模式", type: "select", target: "config", default: 0, options: [
        { value: "0", label: "公开网页信源" },
        { value: "1", label: "优质权威垂直信源" },
        { value: "2", label: "混合结果" },
      ], help: "极速版不支持该参数。" },
      { key: "industry", label: "垂直领域", type: "select", target: "config", options: [
        { value: "", label: "不限定" },
        { value: "gov", label: "政府" },
        { value: "news", label: "新闻" },
        { value: "acad", label: "学术" },
        { value: "finance", label: "财经" },
      ] },
      { key: "site", label: "网址搜索/过滤", type: "text", target: "config", placeholder: "zhihu.com 或 exclude:a.com|b.com", help: "指定搜索传域名；过滤用 exclude: 前缀，最多 5 个。" },
    ],
  },
  {
    type: "bailian",
    name: "阿里云百炼（联网搜索）",
    category: "ai",
    capability: "grounded_answer",
    authType: "api_key",
    implementation: "builtin",
    docsUrl: "https://help.aliyun.com/zh/model-studio/web-search",
    description:
      "百炼 DashScope 原生联网搜索：返回模型回答与 search_info.search_results（title/url/site_name）。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：OpenAI 兼容通道无法返回搜索来源，因此本适配器使用 DashScope 原生 /api/v1/services/aigc/text-generation/generation，parameters.result_format=message + enable_search + enable_source。baseUrl 必须是 https://{WorkspaceId}.{region}.maas.aliyuncs.com，不能硬编码单一地域。无真实 Key，未联调。",
    fields: [
      { key: "model", label: "Model ID", type: "text", target: "model", required: true, placeholder: "qwen-plus" },
      { key: "endpoint", label: "工作空间地址", type: "text", target: "baseUrl", required: true, placeholder: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com", help: "按你的业务空间与地域填写；不同地域地址不同。" },
      { key: "searchStrategy", label: "搜索策略", type: "select", target: "config", default: "turbo", options: [
        { value: "turbo", label: "turbo（日常查询）" },
        { value: "max", label: "max（高精度）" },
        { value: "agent", label: "agent（研究型，仅部分模型）" },
        { value: "agent_max", label: "agent_max（含抓取，仅部分模型）" },
      ] },
      { key: "forcedSearch", label: "强制联网", type: "boolean", target: "config", default: false },
      { key: "assignedSites", label: "限定站点", type: "text", target: "config", placeholder: "baidu.com,sina.cn", help: "最多 25 个，仅 turbo 策略生效。" },
    ],
  },
  {
    type: "qianfan-search",
    name: "百度千帆 AI 搜索",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://qianfan.baidubce.com",
    docsUrl: "https://cloud.baidu.com/doc/qianfan-api/s/Jmwbl4qxs",
    description:
      "百度千帆 AI 搜索 web_search：真实网页在 references[] 中，含 title/url/web_anchor/website/snippet/content/date/rerank_score。",
    verification: "documented",
    notes:
      "官方文档已核对：POST /v2/ai_search/web_search，Bearer 鉴权；messages 仅支持单轮（取最后一条 user content）；resource_type_filter 的 web top_k 上限 50；edition 支持 standard/turbo/pro。无真实 Key，未联调。",
    fields: [
      { key: "edition", label: "搜索版本", type: "select", target: "config", default: "standard", options: [
        { value: "standard", label: "standard（标准版）" },
        { value: "turbo", label: "turbo（增强版）" },
        { value: "pro", label: "pro（旗舰版）" },
      ], help: "不同版本计费不同。" },
      { key: "site", label: "限定站点", type: "text", target: "config", placeholder: "www.weather.com.cn" },
    ],
  },
  {
    type: "stepfun",
    name: "阶跃星辰（网页搜索）",
    category: "general",
    capability: "raw_search",
    authType: "api_key",
    implementation: "builtin",
    defaultBaseUrl: "https://api.stepfun.com",
    docsUrl: "https://platform.stepfun.com/docs/zh/api-reference/Search/search",
    description:
      "阶跃星辰独立网页搜索接口：返回 url/position/title/time/snippet/content，可按场景分类检索。",
    verification: "documented",
    notes:
      "官方文档已核对（2026-11-15）：POST /v1/search，query 必填，n 取 1–20，category 支持 programming/research/gov/business。文档说明 step-5-preview 等模型不支持 Chat Completions 内置 web_search，官方推荐先调本接口再把结果交给模型，因此这里是 raw_search 而不是 grounded_answer。另有远程 MCP（/step_plan/v1/mcp/web_search/mcp）未在本轮接入。无真实 Key，未联调。",
    fields: [
      { key: "category", label: "检索场景", type: "select", target: "config", options: [
        { value: "", label: "全部场景" },
        { value: "programming", label: "programming" },
        { value: "research", label: "research" },
        { value: "gov", label: "gov" },
        { value: "business", label: "business" },
      ] },
    ],
  },
  {
    type: "search-gateway",
    name: "Search Gateway（兼容）",
    category: "compat",
    authType: "bearer",
    implementation: "generic",
    description: "已有私有 Search Hub 网关：通过 Generic HTTP 适配器接入，需自行填写端点与字段映射。",
    verification: "unverified",
  },
  {
    type: "alt-search-gateway",
    name: "Alt Search Gateway（兼容）",
    category: "compat",
    authType: "bearer",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
  {
    type: "premium",
    name: "Premium（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
  {
    type: "orz-fetch",
    name: "ORZ Fetch（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
  {
    type: "union-free",
    name: "Union Free（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
  {
    type: "zhihu-radar",
    name: "Zhihu Radar（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
  {
    type: "gpt55",
    name: "GPT55（兼容）",
    category: "compat",
    authType: "api_key",
    implementation: "generic",
    description: "已有私有网关：通过 Generic HTTP 适配器接入。",
    verification: "unverified",
  },
];

export const CATALOG_BY_TYPE = new Map(PROVIDER_CATALOG.map((entry) => [entry.type, entry]));

export function getCatalogEntry(type: string): ProviderCatalogEntry | undefined {
  return CATALOG_BY_TYPE.get(type);
}
