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
    description: "Brave 官方 Web Search API，需要订阅令牌，支持语言与时间范围过滤。",
    verification: "documented",
    notes: "适配器按官方 Web Search API 文档实现；无订阅 Key 且 api.search.brave.com 在当前开发网络不可达，未联调。",
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
    notes: "已核对：官方 playground 的路径与查询参数；未核实：请求 host、鉴权方式、响应字段。核实前不提供原生适配器；可先用 Generic HTTP 自行接入并明确标注协议。",
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
    authType: "api_key",
    implementation: "planned",
    docsUrl: "https://ai.google.dev/gemini-api/docs/google-search",
    description: "通过 Gemini API 的 Google Search grounding 获取带引用的联网结果；与普通网页搜索 API 的返回结构不同。",
    verification: "documented",
    notes: "需要单独的 AI 搜索适配层，计划在 Phase 2 实现。",
  },
  {
    type: "grok",
    name: "xAI Grok（Live Search）",
    category: "ai",
    authType: "api_key",
    implementation: "planned",
    docsUrl: "https://docs.x.ai/docs/guides/live-search",
    description: "xAI Live Search 通过 Chat Completions 的 search 参数联网；返回为模型回答与引用。",
    verification: "documented",
    notes: "属于模型联网搜索，不是独立 SERP API。",
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
    name: "小米 MiMo",
    category: "ai",
    authType: "api_key",
    implementation: "planned",
    description: "目标兼容源。未确认可公开验证的联网搜索接口。",
    verification: "unverified",
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
    name: "阿里云百炼",
    category: "ai",
    authType: "api_key",
    implementation: "planned",
    docsUrl: "https://help.aliyun.com/zh/model-studio",
    description: "目标兼容源。百炼提供模型服务与检索增强组件，具体联网搜索接口需按官方文档核实。",
    verification: "unverified",
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
    name: "阶跃星辰 StepFun",
    category: "ai",
    authType: "api_key",
    implementation: "planned",
    docsUrl: "https://platform.stepfun.com",
    description: "目标兼容源。需确认其联网搜索接口与返回结构。",
    verification: "unverified",
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
