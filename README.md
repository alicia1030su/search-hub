<a id="top"></a>
# Search Hub

**自托管的 AI 聚合搜索基础设施：统一管理多搜索源与 Key 池，通过 REST、MCP、Skills 和 CLI 提供同一套搜索能力。**

[English](./README_EN.md) · [部署](./docs/deployment.md) · [CLI](./docs/cli.md) · [API](./docs/api.md)

> **v0.1.18 Stable。** 本版新增策略化搜索、可解释诊断、真流式与统一正文读取，并修复搜索核心缺陷；具体变更见 [CHANGELOG](./CHANGELOG.md)。
>
> Stable 是公开发布渠道，不等于所有第三方集成都通过生产认证；未联调与未实现能力见下文“限制”。
<a id="highlights"></a>
## 核心特点

| 特点 | 说明 |
|---|---|
| 多源并发与部分成功 | 单源失败不拖垮整体搜索，返回可用结果与明确失败原因 |
| Key 池与额度治理 | 每 Key 独立并发、RPM、日配额、冷却与熔断，支持多种调度策略 |
| 策略化搜索与融合 | Fast/Balanced/Quality/Deep 与本地自动路由；有界候选池、URL 去重、RRF/重排，保留来源与原始排名 |
| 持久缓存与资源可视 | SQLite 缓存支持 TTL/LRU，后台可查看缓存、队列与进程资源 |
| 加密备份与隔离恢复 | `.shbackup` 包含一致性数据库与匹配主密钥，恢复默认 dry-run |
| 四种入口，一套核心 | REST、MCP、Agent Skills、`shub` CLI 共用搜索链路；REST/CLI 支持 SSE/NDJSON，四入口支持按需正文读取与缓存状态 |

<a id="screenshots"></a>
## 界面

<!-- CAPTURE_REQUIRED: replace with the real v0.1.18 docs/screenshots/v0118/onboarding.png after capture. -->
<!-- CAPTURE_REQUIRED: replace with the real v0.1.18 docs/screenshots/v0118/dashboard.png after capture. -->
<!-- CAPTURE_REQUIRED: replace with the real v0.1.18 docs/screenshots/v0118/search-lab.png after capture. -->
<!-- CAPTURE_REQUIRED: replace with the real v0.1.18 docs/screenshots/v0118/provider-health.png after capture. -->
<a id="quick-start"></a>
## 快速开始

| 部署方式 | 前提 | 启动入口 |
|---|---|---|
| Windows x64 独立包 | 无需 Node/pnpm/Docker | 解压后运行 `SearchHub.exe` |
| Linux x64 独立包 | 无需 Node/pnpm | `./bin/search-hub` |
| Linux arm64 独立包 | 无需 Node/pnpm | `./bin/search-hub` |
| Docker Compose | Docker | `docker compose up -d` |

### Docker Compose

```bash
git clone https://github.com/alicia1030su/search-hub.git
cd search-hub
cp .env.example .env
# 建议设置固定主密钥：openssl rand -hex 32
# 将生成的 64 位十六进制值写入 .env 的 SEARCH_HUB_ENCRYPTION_KEY
docker compose up -d
docker compose logs -f search-hub
curl -fsS http://127.0.0.1:8787/api/health
```

打开 `http://127.0.0.1:8787` 创建管理员；没有默认账号。首次初始化需要一次性 setup token：

```bash
docker compose exec search-hub cat /app/data/setup-token
```

仅在未设置 `SEARCH_HUB_SETUP_TOKEN` 时使用上述命令；token 值不打印到日志，请从 0600 文件读取，初始化后 best-effort 删除，残留 token 已失效。

### Windows x64

1. 从下方 Release 下载 `search-hub-v0.1.18-windows-x64.zip` 并校验。
2. 解压到可写目录，数据保存在 `%LOCALAPPDATA%\SearchHub`。
3. 首次启动前读取 `%LOCALAPPDATA%\SearchHub\setup-token`（若尚未生成，先启动一次）。
4. 双击 `SearchHub.exe`，在 `/setup` 输入 token 并创建管理员。

### Linux x64 / arm64

```bash
# Linux x64
mkdir search-hub
tar -xzf search-hub-v0.1.18-linux-x64.tar.gz -C search-hub
cd search-hub && ./bin/search-hub
```

Linux arm64 使用 `search-hub-v0.1.18-linux-arm64.tar.gz`，其余步骤相同。默认监听 `127.0.0.1:8787`；长期运行可使用包内 `search-hub.service`。

**下载与校验**

从 [v0.1.18 Release](https://github.com/alicia1030su/search-hub/releases/tag/v0.1.18) 下载以下资产；独立服务端包已包含运行时。

| 平台 / 用途 | 服务端 | CLI `shub` | 额外前提 |
|---|---|---|---|
| Windows x64 | `search-hub-v0.1.18-windows-x64.zip` | `shub-v0.1.18-windows-x64.zip` | 无 |
| Linux x64 | `search-hub-v0.1.18-linux-x64.tar.gz` | `shub-v0.1.18-linux-x64.tar.gz` | 无 |
| Linux arm64 | `search-hub-v0.1.18-linux-arm64.tar.gz` | `shub-v0.1.18-linux-arm64.tar.gz` | 无 |
| Node.js >=22.12.0 便携 CLI | — | `shub-v0.1.18-node22.tar.gz` | Node.js >=22.12.0 |

Release 同时提供 `SHA256SUMS` 与 `resource-evidence.json`，共 9 个资产；下载后执行：

```bash
sha256sum -c SHA256SUMS
```

在已克隆的仓库中使用发布镜像（镜像仅构建 `linux/amd64`）：

```bash
SEARCH_HUB_IMAGE=ghcr.io/alicia1030su/search-hub:0.1.18 docker compose up -d
```

arm64 主机请使用 arm64 独立包；Docker arm64 模拟运行不在项目验证范围。

<a id="interfaces"></a>
## REST / MCP / Skills / CLI

| 入口 | 地址 / 形式 | 认证 | 文档 |
|---|---|---|---|
| REST | `POST /api/search`、`/api/search/deep`、`/api/search/stream`、`/api/web/read` | Bearer `search` scope | [API](./docs/api.md) |
| MCP HTTP | `POST /mcp`，Streamable HTTP | Bearer `mcp:use`；搜索工具另需 `search`；`get_search_sources` 另需 `sources:read` | [MCP](./docs/mcp.md) |
| MCP stdio | `packages/mcp/dist/stdio.mjs`，代理同一 REST API | 同一 Token 与分层 scope：`mcp:use`、搜索工具 `search`、`get_search_sources` 的 `sources:read` | [MCP](./docs/mcp.md) |
| Agent Skills | `search-web`、`deep-research`、`fetch-webpage`、`research-with-citations` | `search` scope | [Skills](./docs/skills.md) |
| CLI | 独立 `shub`，复用 REST API | 环境变量或 `--token-stdin` | [CLI](./docs/cli.md) |

### CLI 示例

```bash
export SEARCH_HUB_URL="http://127.0.0.1:8787"
export SEARCH_HUB_TOKEN="sh_replace_with_your_token"
shub search "Linux" --json
shub search "Linux" --stream --stream-format ndjson
shub fetch https://www.python.org/ --json
shub sources --enabled --json
```

`search` 需要 `search` scope，`sources` 还需要 `sources:read`。JSON 模式 stdout 只有合法 JSON；Token 不写入明文配置。

<a id="providers"></a>
## Provider 分类

目录共 58 项：50 个原生适配器（7 个 `live_tested`、42 个 `documented`、1 个 `mock_verified`）、7 个 generic 预设、1 个无官方 API 条目。已真实联调的是 Hacker News、Crossref、OpenAlex、PubMed、Wikipedia、arXiv、GitHub；目录条目不等于已验证可用。逐源状态见 [Provider matrix](./docs/provider-matrix.md)。

<a id="docs"></a>
## 文档

[架构](./docs/architecture.md) · [部署](./docs/deployment.md) · [独立包](./docs/standalone-packages.md) · [备份灾备](./docs/disaster-recovery.md) · [Provider 健康](./docs/provider-health.md) · [测试](./docs/testing.md)
[CHANGELOG](./CHANGELOG.md) · [安全](./SECURITY.md)

<a id="limits"></a>
## 限制

- 多实例未实现：当前为单进程额度治理与 SQLite；Redis 协调、PostgreSQL 适配未实现。
- 多数付费厂商仅有本地契约测试，未用真实凭证联调；不要据此宣称生产可用。
- 质量评测实验室包含合成基准与 40 条真实网页查询草案，用于可复现对比；不代表全面质量提升或厂商排名。
- MCP 工具仍返回单次 JSON；REST 的 SSE/NDJSON 不等于 MCP 服务端发起的流式订阅。

<a id="license"></a>
## 许可证

本项目采用 [MIT 许可证](./LICENSE)。
