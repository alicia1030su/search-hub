# Search Hub

**自托管的 AI 聚合搜索基础设施。** 一套服务，聚合多个搜索源，管理多组 API Key，输出统一结果，并通过 REST、MCP 与 Agent Skills 同时对外提供能力。

[English](./README_EN.md) · [架构](./docs/architecture.md) · [部署](./docs/deployment.md) · [API](./docs/api.md) · [MCP](./docs/mcp.md) · [Skills](./docs/skills.md) · [测试](./docs/testing.md)

> 状态：`0.1.0`。核心搜索闭环、Key 池调度、管理后台、REST API、MCP（双协议）与 Skills 已实现并通过自动化测试。真实第三方搜索 API 的联调状态见下方[验证状态](#验证状态)，未联调的能力不会被描述为“已验证”。

---

## 它解决什么问题

单个搜索 API 会遇到三个问题：额度单点、故障单点、结果单一。自己写聚合脚本又要重复处理 Key 轮换、限速、去重、融合和对外协议。

Search Hub 把这些做成一个可部署的服务：

- **多源并发**：一次查询同时发给多个搜索源，单源失败不影响整体，返回部分成功结果与失败原因。
- **Key 池**：同一搜索源可配置任意多个 Key，支持轮询、随机、加权随机、最少使用、故障切换；每 Key 独立并发、RPM、日配额、冷却与熔断。
- **统一结果**：URL 规范化、精确/近似去重、RRF 融合，保留每个结果的命中来源与原始排名。
- **三个入口，一套核心**：REST、MCP、Agent Skills 全部调用同一个 `executeSearch`，不存在第二套实现。
- **可选智能增强**：AI 摘要（带 `[n]` 引用）、Embedding 语义重排、Rerank。未配置模型时普通搜索完全可用。

## 核心能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 多源并发搜索 + 部分成功 | 已实现 | 单源超时、全局 deadline、独立错误隔离、客户端取消 |
| Key 池调度（5 种策略） | 已实现 | 原子占额，100 并发下不突破每 Key 并发上限 |
| 429 / 401 / 5xx 差异处理 | 已实现 | 429 按 `Retry-After` 冷却；401/403 暂停 Key；5xx 指数退避 + 熔断 |
| URL 规范化 + 去重 + RRF | 已实现 | 保留全部来源；RRF k 可配，默认 60 |
| 管理后台（浅/深色、中文） | 已实现 | 仪表盘、搜索源、Key、模型、搜索实验室、集成、设置与日志 |
| REST API + OpenAPI 3.1 | 已实现 | `/api/openapi.json` 与 `/api/docs` |
| MCP Server | 已实现 | 2026-07-28 现代协议 + 2025-11-25 传统握手；Streamable HTTP + stdio |
| Agent Skills | 已实现 | 3 个 `SKILL.md`，遵循 agentskills.io 结构 |
| AI 摘要 / Embedding / Rerank | 已实现（可选） | OpenAI 兼容 / Anthropic / Gemini / Cohere-Jina 兼容 / custom-http |
| PostgreSQL | 未实现 | 当前仅 SQLite；接口已隔离，见[已知限制](#已知限制) |
| Redis 多实例协调 | 未实现 | 单进程额度保证；多实例方案见架构文档 |

## 支持的搜索源

**已实现适配器（4 类）**

| 类型 | 鉴权 | 说明 | 验证状态 |
|---|---|---|---|
| `brave` | API Key | Brave Web Search API，`X-Subscription-Token` | 按官方文档实现；**无真实 Key，未联调** |
| `searxng` | 可选 | 自建实例 `/search?format=json`，需启用 JSON 输出 | 按官方文档实现；**未对真实实例联调** |
| `generic-http` | 可配置 | 声明式映射 URL/Headers/Body/结果路径，覆盖长尾 API | 本地模拟服务测试通过 |
| `mock` | 无 | 确定性测试源，支持延迟与故障注入 | 自动化测试使用 |

**目录中列出但尚未实现**：DuckDuckGo、百度、秘塔、博查、AnySearch、Gemini、Grok、MiniMax、MiMo、DeepSeek、豆包、腾讯元宝、百炼、千帆、阶跃星辰，以及 Search Gateway 等 7 个兼容网关。它们要么没有可公开验证的官方接口，要么需要单独的 AI 搜索适配层；界面中标注为“仅目录 · 未实现”，**不能创建**。兼容网关可通过 `generic-http` 自行接入。

> 目录共 26 条：4 个可用适配器、13 个 planned、2 个无官方接口、7 个 generic 兼容入口。项目**不声称支持 26 个搜索源**。

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/search-hub/search-hub.git
cd search-hub
cp .env.example .env
# 强烈建议写入一个固定主密钥：openssl rand -hex 32
# 编辑 .env，填入 SEARCH_HUB_ENCRYPTION_KEY
docker compose up -d
```

打开 `http://localhost:8787`，首次进入会要求创建管理员（没有默认密码）。随后：

1. **搜索源 → 添加搜索源**，选择 Brave（填 Key）或 SearXNG（填自建地址），也可以先加一个 Mock 源验证流程。
2. **测试** 按钮会发起真实请求；失败会显示具体错误码与原因。
3. **搜索实验室** 输入查询，勾选搜索源，运行。能看到每个源的耗时、失败原因、去重前后数量、融合排名。
4. **集成** 创建访问令牌，复制 MCP 配置。

### 本地开发

```bash
corepack pnpm install
corepack pnpm build          # 构建前端
corepack pnpm dev            # API :8787 + Vite :5173
corepack pnpm test           # 单元 + 集成测试
```

要求 Node ≥ 22.12（`better-sqlite3` 13 与 Vite 8 的下限），pnpm 12。

## 配置搜索源与 Key

每个搜索源可创建多个独立实例（例如 `brave-eu`、`brave-us`），每个实例有自己的地址、Key 池、并发、优先级与调度策略。

- **Key 加密**：AES-256-GCM，主密钥来自 `SEARCH_HUB_ENCRYPTION_KEY` 或自动生成的 `data/master.key`。API 只返回掩码（`…abcd`）。
- **调度策略**：`round_robin` / `random` / `weighted_random` / `least_used` / `failover`。
- **额度**：每 Key 并发上限 + 每分钟请求数 + 每日配额（可选）；超限返回明确错误，不静默丢请求。
- **健康状态**：`healthy` / `rate_limited` / `cooldown` / `invalid` / `disabled` / `unknown`，可在 Key 面板单独测试与重置。

## 连接 MCP

服务端同时提供 Streamable HTTP 与 stdio：

**远程（HTTP）**

```json
{
  "mcpServers": {
    "search-hub": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer sh_your_token" }
    }
  }
}
```

令牌需要 `mcp:use` 权限，在 **集成 → 访问令牌** 创建，只显示一次。

**本地（stdio，代理到同一 REST API）**

```json
{
  "mcpServers": {
    "search-hub": {
      "command": "npx",
      "args": ["tsx", "/path/to/search-hub/packages/mcp/src/stdio.ts"],
      "env": {
        "SEARCH_HUB_URL": "http://127.0.0.1:8787",
        "SEARCH_HUB_TOKEN": "sh_your_token"
      }
    }
  }
}
```

工具：`search_web`、`search_multi`、`search_deep`、`search_news`、`search_with_sources`、`search_and_rerank`、`search_and_summarize`、`get_search_sources`、`get_search_status`。

stdio 模式是 REST 代理：关闭 REST API 后 stdio 调用会失败，这证明它没有第二套搜索实现。协议细节见 [docs/mcp.md](./docs/mcp.md)。

## 安装 Agent Skills

`packages/skills/` 下有三个标准 `SKILL.md`：

- `search-web`：单次搜索与引用规范
- `deep-research`：多查询深度研究
- `research-with-citations`：可审计的证据表

把对应目录复制到你的 Agent 客户端 skills 目录，或从 **集成 → Skills** 下载。Skill 只需要 `SEARCH_HUB_URL` 与 `SEARCH_HUB_TOKEN`，不需要在客户端保存任何搜索提供商的 Key。

## 添加自定义搜索源

不需要改代码：**搜索源 → 添加 → 通用 HTTP/JSON**，填写：

- 请求方法、路径、Headers、Query、JSON Body（支持 `{{query}}` `{{key}}` `{{limit}}` `{{language}}` `{{freshness}}` `{{page}}`）
- Key 注入位置（header / query / body，支持前缀）
- 结果数组路径（如 `data.items`）
- 字段映射（title / url / snippet / publishedAt / score / language）

映射是声明式的，路径只允许 `a.b[0].c` 形式，不执行任何用户代码。详见 [docs/providers.md](./docs/providers.md)。

## 安全默认值

- 首次初始化必须设置管理员密码，没有默认凭据；可选 `SEARCH_HUB_SETUP_TOKEN`。
- 管理 API 需要 HttpOnly 会话 Cookie，写操作额外校验 CSRF Header；外部集成使用可撤销、带 scope、带限流的 Bearer Token。
- 所有出站请求经过 SSRF 防护：DNS 解析校验 + 连接期 `lookup` 校验 + 手动重定向逐跳校验；默认拒绝回环、私网、链路本地与云元数据地址。内网服务需加入管理员白名单。
- 日志对 `authorization`、`cookie`、`apiKey`、`password`、`token` 做脱敏；密钥不出现在 API 响应、导出文件或日志中。
- 检索内容始终作为不可信外部数据送入模型；系统提示明确禁止执行其中的指令，并对常见注入模式做检测。
- 前端生产构建启用 CSP、`X-Frame-Options: DENY`、`nosniff` 等响应头。

详见 [SECURITY.md](./SECURITY.md)。发现漏洞请按其中的私下报告流程处理，不要开公开 issue。

## 验证状态

**已自动化验证（本仓库，可复现）**

- 单元 + 集成测试 139 项，覆盖 Key 调度并发、429/401/5xx 状态机、去重、RRF 手算、SSRF、密钥加密、Provider 映射、模型适配器、MCP 双协议、100 并发搜索、重启持久化。
- 端到端脚本 `tests/scripts/smoke.sh` 覆盖：初始化 → 添加双源 → 测试 → 加 Key → 多源搜索 → 故障隔离 → Token → MCP initialize。
- Playwright 覆盖首次安装、登录、添加源、搜索实验室、主题、设置、集成页。

**未验证（需要真实凭证或环境）**

- Brave：没有订阅 Key，未对 `api.search.brave.com` 发起真实请求。
- SearXNG：没有自建实例，未对真实实例联调。
- AI 模型、Embedding、Rerank：没有真实厂商 Key，仅用本地模拟服务验证请求/响应契约。
- 多实例部署：未实现 Redis 协调，当前仅保证单进程额度。

这些限制同时写在 [docs/testing.md](./docs/testing.md) 与发布说明中。

## 已知限制

- **SQLite only**：PostgreSQL 未实现。数据访问集中在 `packages/db` 与 API 服务层，迁移路径已隔离。
- **单实例额度**：Key 并发与 RPM 状态在进程内，崩溃重启后最多丢失当前 60 秒窗口与在途计数；启动时按当日事件近似校准。`kill -9` 下的额度不构成硬保证。
- **Rerank / Embedding 不做持久索引**：Embedding 仅用于单次请求内的语义重排，没有向量库。
- **未实现多租户**：单个管理员，无团队权限模型。
- **速率限制为进程内**：多实例部署时每个实例独立计数。

## 项目结构

```
apps/api           Fastify：REST、管理 API、MCP 挂载、静态前端
apps/web           React + Vite + Tailwind 管理后台
packages/shared    类型、Zod 契约、URL 规范化、SSRF 安全 HTTP
packages/db        Drizzle schema、手写迁移、SQLite 客户端
packages/core      KeyScheduler、并发扇出、去重、RRF、错误分类
packages/providers Provider 插件、目录、Brave/SearXNG/Generic/Mock
packages/models    Chat / Embedding / Rerank 适配器、摘要与注入防护
packages/mcp       MCP v2 Server（HTTP + stdio）
packages/skills    3 个 SKILL.md
docs               架构、API、MCP、Skills、Provider、部署、测试
tests              unit / integration / e2e / scripts
```

## 测试

```bash
pnpm test                 # Vitest：单元 + 集成
pnpm build && pnpm test:e2e
bash tests/scripts/smoke.sh http://127.0.0.1:8787
```

测试分层、覆盖范围与未覆盖项见 [docs/testing.md](./docs/testing.md)。

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。新增 Provider 必须附带：接口文档链接、错误映射、Mock 测试、真实联调状态（未联调就写未联调）。

## 许可证

[MIT](./LICENSE)
