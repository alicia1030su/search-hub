# Search Hub v0.1.4 交付报告

日期：2026-11-15 ｜ 分支：`feat/v0.1.4-search-providers` ｜ PR #3（未合并）

## 1. 本轮完成的功能

| 模块 | 交付内容 |
|---|---|
| Provider Manifest | 每个 Provider 一份声明式能力文档（能力、鉴权、端点、参数与厂商上限、分页、账户额度、字段映射、文档、验证状态），由 catalog 派生，`GET /api/admin/providers → manifests` 输出 |
| 独立搜索参数 | 迁移 0002 新增 `search_config_json`：targetResults / maxPages / maxRequestsPerSearch / region / safeSearch / searchDepth / includeDomains / excludeDomains / sort / locked；不支持即拒绝并给出原因 |
| 真实分页 | Brave offset 分页（每页 20、最多 10 页），50 条目标 = 3 次请求；上游不足如实返回并告警；Brave / Serper / SearchApi / SerpApi / Naver / Kakao / Yandex 已接入 |
| 搜索源市场 | 双标签、筛选（分类/鉴权）、复选框多选、批量添加、一键添加全部、一键启用就绪项（含费用确认）、全部禁用；未配凭证一律不启用 |
| 账户级额度 | `AccountQuotaRegistry`，同组多 Key 共用一份预算；耗尽返回 `quota_exceeded`；明确标注单进程 |
| Generic MCP | Streamable HTTP 客户端（initialize/initialized/tools/list/tools/call），SSE 与 JSON 双解析，工具自动发现、参数模板、字段映射；**无 stdio** |
| 搜索模式 | `web` / `grounded` / `research`，服务端按能力过滤，REST/MCP/Skills 一致 |
| Web UI | 搜索源页重构（我的搜索源 / 搜索源市场）、Manifest 驱动表单、高级设置折叠、首页空态引导、实验台三模式与联网状态网格 |
| 搜索实验室 | 原始结果 / AI 回答分离；五项联网状态；引用支撑区间；模型名、耗时、脱敏错误 |

## 2. Provider 实现与验证状态

总计 **57 个目录条目**，**47 个已实现适配器**。

| 状态 | 数量 | 说明 |
|---|---|---|
| `live_tested` | 5 | hackernews、crossref、openalex、pubmed、mock — 真实 HTTP 调用返回结果 |
| `documented` | 42 | 按官方文档实现 + 契约测试；**本环境无厂商凭证，未联调** |
| `planned` | 2 | metaso、minimax（原因见第 8 节） |
| `unavailable` | 1 | baidu（无公开通用网页搜索 API，已由 qianfan-search 覆盖） |

### 本轮新增（22 个原生 + 2 个兼容）

| 分类 | Provider |
|---|---|
| 网页搜索 API | exa、firecrawl、serper、serpapi、searchapi、dataforseo、perplexity-search、youcom、jina-search、parallel-search、linkup-search |
| 模型联网 | openai-websearch、anthropic-websearch、mistral-websearch、perplexity-sonar |
| 区域搜索 | naver、kakao、yandex |
| 学术/垂直 | wikipedia、crossref、openalex、pubmed、semanticscholar、europepmc、gdelt、github、arxiv |
| 兼容 | duckduckgo（仅 Instant Answer）、generic-mcp |

### 官方文档依据（逐条核对，2026-11-15）

| Provider | 端点 | 文档 |
|---|---|---|
| Exa | `POST /search`，`x-api-key`，numResults ≤100，无 offset | https://docs.exa.ai/reference/search |
| Firecrawl | `POST /v2/search`，`data.web[]` | https://docs.firecrawl.dev/features/search |
| Serper | `POST /search`，`X-API-KEY`，`page` 1 基 | https://serper.dev/ |
| SerpApi | `GET /search.json`，`api_key` 查询参数 | https://serpapi.com/search-api |
| SearchAPI.io | `GET /api/v1/search`，`page` 1 基 | https://www.searchapi.io/docs/google |
| DataForSEO | `POST /v3/serp/google/organic/live/advanced`，Basic `login:password` | https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ |
| Perplexity Search | `POST /search`，max_results ≤20 | https://docs.perplexity.ai/api-reference/search-post |
| Perplexity Sonar | `POST /chat/completions`，`citations[]` + `search_results[]` | https://docs.perplexity.ai/api-reference/chat-completions-post |
| You.com | `GET /v1/search`，`X-API-Key`，`results.web[]` | https://docs.you.com/api-reference/search |
| Jina Search | `GET s.jina.ai/{query}`，`data[]` | https://jina.ai/reader/ |
| Parallel | `POST /v1beta/search`，`x-api-key` | https://docs.parallel.ai/search-api/search |
| Linkup | `POST /v1/search`，`outputType=searchResults` | https://docs.linkup.so/pages/documentation/api-reference/endpoint/search |
| OpenAI | `POST /v1/responses`，`tools:[{type:"web_search"}]` | https://platform.openai.com/docs/guides/tools-web-search |
| Anthropic | `POST /v1/messages`，`web_search_20250305` | https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool |
| Mistral | `POST /v1/conversations`，`tools:[{type:"web_search"}]` | https://docs.mistral.ai/capabilities/tools/ |
| Naver | `GET /v1/search/webkr`，双头鉴权 | https://developers.naver.com/docs/serviceapi/search/web/web.md |
| Kakao | `GET /v2/search/web`，`KakaoAK` | https://developers.kakao.com/docs/latest/ko/daum-search/dev-guide |
| Yandex | `POST /v2/web/search`，`Api-Key` | https://yandex.cloud/en/docs/search-api/ |
| Wikipedia | `GET /w/api.php?action=query&list=search` | https://www.mediawiki.org/wiki/API:Search |
| Crossref | `GET /works` | https://api.crossref.org/swagger-ui/index.html |
| OpenAlex | `GET /works` | https://docs.openalex.org/api-entities/works/search-works |
| PubMed | `esearch.fcgi` → `esummary.fcgi` | https://www.ncbi.nlm.nih.gov/books/NBK25501/ |
| Semantic Scholar | `GET /graph/v1/paper/search` | https://api.semanticscholar.org/api-docs/ |
| Europe PMC | `GET /europepmc/webservices/rest/search` | https://europepmc.org/RestfulWebService |
| GDELT | `GET /api/v2/doc/doc` | https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ |
| GitHub | `GET /search/repositories` | https://docs.github.com/en/rest/search/search |
| arXiv | `GET /api/query`（Atom XML） | https://info.arxiv.org/help/api/index.html |
| DuckDuckGo | `GET api.duckduckgo.com/?format=json` | https://duckduckgo.com/api |
| Generic MCP | Streamable HTTP | https://modelcontextprotocol.io/specification/2025-06-18/basic/transports |

### 真实联调证据

```
$ node --import tsx tests/scripts/live-adapters.mts
PASS crossref   rows=3 2545ms  https://doi.org/10.7717/peerj-cs.3254/fig-10
PASS openalex   rows=3 1391ms  https://doi.org/10.1109/tvcg.2023.3327163
PASS pubmed     rows=3 2586ms  https://pubmed.ncbi.nlm.nih.gov/39422983/
```

其余 42 个适配器**没有真实凭证**，状态保持 `documented`，不升级为 `live_tested`。

## 3. Web UI 与截图

截图位于 `docs/screenshots/`，均由真实构建 + 真实后端 + 真实安装流程生成：

| 文件 | 内容 |
|---|---|
| `v014-dashboard-empty.png` | 首页：全新安装的空态引导 |
| `v014-empty.png` | 我的搜索源：零实例 |
| `v014-market.png` | 搜索源市场：分类、筛选、多选、批量按钮 |
| `v014-installed.png` | 一键添加后：47 个实例，全部未启用，带就绪徽章 |
| `v014-params.png` | Provider 表单：Manifest 驱动的搜索参数 |
| `v014-lab.png` | 搜索实验室：三种预设 |

## 4. 测试结果

| 检查 | 结果 |
|---|---|
| Vitest | **548 passed** |
| Playwright | **17 passed** |
| typecheck | 0 errors |
| lint | 0 warnings / 0 errors |
| production build | exit 0 |
| Secret scan | 0 violation |
| AC matrix | 11 PASS / 4 PARTIAL / 1 BLOCKED |

关键新增用例：

- Manifest 一致性、分页规划、不支持参数拒绝
- Brave 50 条 = 3 次请求；上游 12 条时 1 次请求后停止并如实报告
- 批量安装不启用、批量启用跳过未配置凭证、全部禁用
- 首次安装 providers 为空（独立数据库 `fresh-install.test.ts`）
- MCP 握手（initialize → initialized → tools/list → tools/call）
- 血缘：排名不冒充来源（`upstreamRank`）
- 联网状态五项：toolInvoked / retrievalSucceeded / hasVerifiableSources / answerSupported
- XSS：`<script>`、`onclick=`、`javascript:` 全部被拒

## 5. CI 与 Docker

| 项 | 结果 |
|---|---|
| CI（7 项必需检查） | 全部 pass — https://github.com/alicia1030su/search-hub/actions/runs/43722518688 |
| Docker 容器验收 | 24/24，Trivy CRITICAL=0 HIGH=0 — https://github.com/alicia1030su/search-hub/actions/runs/43722518707 |

## 6. 安全审计

| 项 | 结论 |
|---|---|
| 出站通道 | 所有 Provider 走同一个 `SafeFetch`：DNS + CIDR 黑名单、connect 期守卫、每跳重校验、超时与体积上限 |
| 凭证 | 加密存储，仅在内存解密；响应/审计/导出均不含明文（有测试断言） |
| MCP | 只允许远程 http(s)；**无 stdio**，网页用户不能借此执行本地命令 |
| Vendor HTML | Google `searchEntryPoint` 只解析为纯数据，HTML 永不进入后台 |
| SSRF | 私有地址、重定向、非 http(s) 全部拒绝 |
| 权限 | 角色令牌、CSRF、限流保留；SafeSearch 只影响厂商内容过滤，不能关闭安全控制 |

## 7. PR 最新 SHA

`08a2354`（`feat/v0.1.4-search-providers`），PR #3 state=OPEN，mergeStateStatus=CLEAN。

## 8. 无法完成的事项与阻塞证据

| 项 | 阻塞证据 | 处理 |
|---|---|---|
| metaso | 只核实到 `/api/v1/search` 与 q/scope/size/page；host、鉴权头、响应结构未公开 | 标 `planned`，提供 Generic HTTP 接入指引 |
| minimax | 官方 web_search 仅提供本地 stdio MCP（`uvx minimax-coding-plan-mcp`） | 标 `planned`；接受浏览器传入命令等于命令注入 |
| baidu | 通用网页搜索无公开 API | 标 `unavailable`，指向 qianfan-search |
| 42 个 `documented` 适配器 | 本环境无任何厂商凭证 | 代码/配置/契约测试完整，状态不虚报 |

## 9. 是否建议合并

**建议合并**，理由与保留：

1. 所有约定范围内**可自主完成**的开发已完成：Manifest、市场、独立参数、真实分页、账户额度、Generic MCP、三种搜索模式、UI 重构、47 个适配器、548 个测试、CI 与 Docker 全绿。
2. 三条不可绕过的限制已如实标注，不影响代码正确性：无凭证 → 42 个 `documented`；metaso/minimax 缺协议证据 → `planned`；账户额度是**单进程**语义。
3. 没有合并 PR、没有打 Tag/Release、没有推送 GHCR 镜像。

合并后若要继续提升可信度，唯一有效动作是给真实 Key：从 cost 最低的 Exa 或 Serper 开始，逐个把 `documented` 升为 `live_tested`。
