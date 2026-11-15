# v0.1.4 执行状态

> 本文件是本轮开发的**进度事实来源**。每完成一组功能更新一次。
> 最后更新：2026-11-15 ｜ 最新 SHA：见 PR #3

## 基线

- 分支：`feat/v0.1.4-search-providers`
- 上一基线：`461b30a`
- PR：https://github.com/alicia1030su/search-hub/pull/3 （不合并、不打 Tag、不发 Release）

## 任务总览

| 任务 | 范围 | 状态 |
|---|---|---|
| Manifest + 市场基础 | 声明式能力文档、独立参数、真实分页、批量添加 | ✅ 已完成（`461b30a`） |
| A-1 网页搜索 API | Perplexity / You.com / Jina / Parallel / Linkup / SerpApi / SearchAPI / DataForSEO | ✅ 已实现（documented） |
| A-2 模型联网 | OpenAI / Anthropic / Mistral / Perplexity Sonar | ✅ 已实现（documented） |
| A-3 区域搜索 | Naver / Kakao / Yandex | ✅ 已实现（documented） |
| A-4 学术与专业 | Wikipedia / Crossref / OpenAlex / PubMed / Semantic Scholar / Europe PMC / GDELT | ✅ 已实现（3 个 live_tested） |
| B Generic MCP | 可配置远程 MCP 搜索源（Streamable HTTP，无 stdio） | ✅ 已完成 |
| C 市场完善 | 一键添加/启用/禁用、费用确认、筛选、配置引导 | ✅ 已完成 |
| D UI 重构 | 搜索源页 + 表单 + 首页空态 + 实验室模式 | ✅ 搜索源域完成 |
| E 搜索模式 | web / grounded / research 全链路 | ✅ 已完成 |
| F 浏览器验收 | 17 场景 | ✅ 已完成 |

## 已完成

- Provider Manifest（`packages/providers/src/manifest.ts`）与 `GET /api/admin/providers → manifests`
- `search_config_json` 迁移（0002）与参数校验
- Brave 真实分页（offset 0–9、page size 20）
- 批量添加 / 批量启停端点，未配置凭证的源不自动启用
- 市场 UI（我的搜索源 / 搜索源市场 双标签、多选、空状态）
- 5 个新适配器：exa / firecrawl / serper / github / arxiv
- 搜索预设 `web` / `grounded` / `research`（服务端过滤）

## 阻塞与证据

| 项 | 阻塞原因 | 处理 |
|---|---|---|
| 真实厂商联调 | 本环境无任何厂商凭证 | 全部标 `documented`，契约测试 + 模拟服务验证 |
| MiniMax web_search | 官方仅提供本地 stdio MCP（uvx），浏览器传入命令等于命令注入 | 标 `planned`，说明原因 |
| 秘塔 / DuckDuckGo | 无公开可核对的官方协议 | 标 `planned` / `unavailable`，提供 Generic HTTP 入口 |

## 未完成（阻塞，非遗漏）

| 项 | 证据 |
|---|---|
| metaso | 仅核实路径与查询参数，host/鉴权/响应结构未公开 |
| minimax | 官方 web_search 只有本地 stdio MCP，浏览器传入命令属命令注入 |
| baidu | 无公开通用网页搜索 API |
| 42 个 documented | 本环境无厂商凭证 |

## 交付报告

见 `docs/v014-delivery-report.md`。
