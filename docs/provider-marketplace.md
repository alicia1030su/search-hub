# Search Hub v0.1.4 — 搜索源市场与 Provider Manifest

日期：2026-11-15 ｜ 状态：**Phase 1 已实现并测试**

## 1. 三个对象必须分清

| 概念 | 是什么 | 存放在哪 |
|---|---|---|
| **Catalog Entry** | 市场里的供应商定义（有哪些能力、要什么凭证） | 代码内 `PROVIDER_CATALOG` |
| **Provider Manifest** | 上面那份定义的机器可读视图，UI 表单与参数校验都读它 | 由 catalog 派生，`GET /api/admin/providers → manifests` |
| **Provider Instance** | 用户创建的具体配置（地址、凭证、参数、启停） | 数据库 `provider_instances` |
| **Enabled State** | 该实例是否参与搜索 | `provider_instances.enabled` |

同一供应商可以建多个实例（不同地址/凭证/区域），互不影响。

## 2. 全新安装是空的

- `POST /api/setup` 只创建管理员，**不写入任何 provider**。
- 首次进入「我的搜索源」显示空状态并引导去市场。
- 未安装任何源时，`POST /api/search` 返回 400「No enabled search provider matched」。
- 升级既有部署不会清空数据：迁移 0002 只新增列并给默认值。

证据：`tests/integration/fresh-install.test.ts`（独立数据库）。
截图：`docs/screenshots/v014-empty.png`。

## 3. Manifest 规范

```jsonc
{
  "manifestVersion": 1,
  "providerId": "brave",
  "displayName": "Brave Search",
  "category": "general",              // general | ai | vertical | compat | custom
  "capability": "raw_search",         // raw_search | grounded_answer
  "version": "0.1.4",
  "auth":       { "type": "api_key", "credentialKind": "single", "required": true, "fields": [...] },
  "configuration": { "defaultEndpoint": "https://api.search.brave.com", "endpointEditable": false, "fields": [...] },
  "parameters": { "supported": ["targetResults","maxPages","language",...],
                  "limits": { "targetResults": { "min":1, "max":200, "pageSize":20 } } },
  "pagination": { "supported": true, "mode": "offset", "pageSize": 20, "maxPages": 10, "maxResults": 200 },
  "accountQuota": { "scope": "account", "sharedAcrossKeys": true, "note": "..." },
  "resultMapping": { "title": "web.results[].title", "url": "web.results[].url", "snippet": "web.results[].description" },
  "documentationUrl": "https://...",
  "verificationStatus": "documented", // documented | live_tested | mock_verified | unverified | no_official_api
  "implementationStatus": "builtin"   // builtin | generic | planned | unavailable
}
```

**Manifest 只是数据**：不能携带脚本、不能执行命令、不能把用户输入变成服务器请求。需要行为的地方仍然是 TypeScript 适配器。

`endpointEditable` 只对 `compat` / `custom` 为 true；内置适配器的厂商地址保持固定，避免把官方 Key 发到任意地址。

## 4. 每个搜索源的独立参数

| 参数 | 含义 | 未支持时 |
|---|---|---|
| `targetResults` | 期望结果数 | 超过厂商上限 → 保存时 400 |
| `maxPages` | 最多翻页次数 | 厂商不支持分页 → 400「does not support pagination」 |
| `maxRequestsPerSearch` | 单次搜索请求预算 | 与 maxPages 共同上限 |
| `region` / `language` / `freshness` | 地域语言时效 | 不支持的源不显示该字段 |
| `safeSearch` | 内容过滤 off/moderate/strict | 同上 |
| `searchDepth` | fast/balanced/deep（厂商有该概念时） | 同上 |
| `includeDomains` / `excludeDomains` | 域名白/黑名单 | 同上 |
| `sort` | 排序方式 | 同上 |
| `locked` | 锁定后单次请求不能覆盖 | — |

优先级（高 → 低）：**单次请求**（未锁定）→ **实例 searchConfig** → **manifest 默认值**，三者都受厂商硬上限约束。

## 5. 分页是真的分页

以 Brave 为例（count 1–20、offset 0–9）：

| 目标 | 计划 | 实际行为 |
|---|---|---|
| 10 条 | 1 次请求 | 单页返回 |
| 50 条 | 3 次请求（20+20+10） | 依次 offset 0/1/2 |
| 上游只剩 12 条 | 1 次请求后停止 | 如实返回 12 条 + 警告「returned 12 of 50 in 1 request」 |
| 预算 1 次但目标 60 | 1 次请求 | 返回 20 条，绝不假装 60 |

非分页厂商（Exa / Firecrawl / GitHub / arXiv）在 manifest 里 `pagination.supported=false`，UI 不显示分页字段，超上限直接拒绝保存。

## 6. 批量操作与"就绪"

- `POST /api/admin/providers/batch`：一次安装多个。**需要凭证但没有凭证的源一律以 disabled 落地**，因为「已添加」不等于「能用」。
- `POST /api/admin/providers/batch-state`：批量启停。启用时逐条检查，缺凭证的跳过并返回原因（不静默少做）。
- `ready` = enabled **且**（不需要凭证 **或** 至少一把启用的 Key）。
- 未实现适配器的目录项不可添加；界面标注「仅目录 · 未实现」。

## 7. 本轮新增适配器

| type | 协议 | 能力 | 官方文档 |
|---|---|---|---|
| `exa` | `POST /search`，`x-api-key`，`numResults` ≤100，无 offset | raw_search | https://docs.exa.ai/reference/search |
| `firecrawl` | `POST /v2/search`，`data.web[]` | raw_search | https://docs.firecrawl.dev/features/search |
| `serper` | `POST /search`，`X-API-KEY`，`page` 从 1 开始 | raw_search | https://serper.dev/ |
| `github` | `GET /search/repositories`，Token 可选 | raw_search（垂直） | https://docs.github.com/en/rest/search/search |
| `arxiv` | Atom XML，严格字段提取 | raw_search（垂直） | https://info.arxiv.org/help/api/index.html |

全部为 `documented`：按官方文档实现并有本地契约测试，**没有真实凭证，未联调**。

## 8. 尚未实现（诚实缺口）

- Perplexity / You.com / Jina / Parallel / Linkup / SerpApi / SearchAPI / DataForSEO：本轮未实现（文档站点或端点在本机不可达，未获得可核对契约）。
- MiniMax：官方 web_search 只有本地 stdio MCP（uvx），浏览器用户注入命令属不可接受风险。
- 秘塔：仅核实到路径与参数。
- OpenAI / Anthropic / Mistral 模型联网工具：未实现。

这些在目录里保持 `planned` 或不存在条目，不会伪装成可用搜索源。
