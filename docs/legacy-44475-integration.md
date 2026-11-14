# 旧版 Search Hub（44475）兼容接入方案

日期：2026-11-14 ｜ 状态：**适配器已实现、23 项契约测试 + 5 项 API 集成测试通过、未连接任何真实旧实例**

## 1. 目标与边界

| 目标 | 做法 |
|---|---|
| 旧服务保持独立运行 | 不改旧服务、不迁移数据、不复制凭据、不重启 |
| 新平台把旧服务当作一个搜索源 | 新增 `search-hub-legacy` 适配器，走旧服务的 REST 搜索接口 |
| 可测试 | 本地 fake 服务覆盖请求/响应/错误映射（`tests/unit/providers-legacy.test.ts`，16 项） |
| 可撤销 | 删除新平台里的这个 Provider 实例即可完全回滚，无残留 schema/任务/密钥 |
| 不影响生产数据 | 只发 `POST {path}` 读结果，不写入旧服务；新平台的搜索历史另存本地 |

**未做且需要单独授权**：连接、探测、修改或重启任何真实旧实例。

## 1.1 协议状态：目前只实现 REST，且这是对旧服务的假设

**没有核实过真实 44475 的接口协议。** 当前实现假设旧服务提供 `POST /api/search`，请求体为
`{query, mode, limit, freshness?, language?}`。这个形状来自**本项目自己的** REST 文档；旧版本可能：

- 使用不同路径（例如 `/search`、带网关前缀）；
- 使用不同字段名；
- 只暴露 MCP 端点，根本不接受 REST。

因此 `transport` 是一个**封闭枚举**，当前只接受 `rest`：

```json
{ "transport": "rest", "path": "/api/search", "mode": "rrf" }
```

写入 `transport: "mcp"` 或其他值会立刻返回 `unsupported`（HTTP 501），**不会静默回退到 REST**——静默回退会把“协议没实现”伪装成“地址配错了”。

**未来扩展点**：MCP 客户端依赖已经存在于仓库（`packages/mcp` 使用官方 SDK），但 MCP 兼容应作为**独立适配器**（例如 `search-hub-legacy-mcp`）实现，而不是在 REST 适配器里加分支。这样两条协议的请求形状、错误码和测试互不污染。当前版本不包含 MCP 兼容。

## 2. 接入架构

```text
新平台 Search Hub
  └─ Provider instance: type=search-hub-legacy
       └─ POST http://<old-host>:44475/api/search
            body: { query, mode:"rrf", limit, freshness?, language? }
            header: Authorization: Bearer <old token>（可选）
       ← { status, results:[...], errors:[...] } 或 { data:{ status, results:[...] } }
```

旧服务仍然是它自己 Provider/Key/配额的唯一管理者；新平台只消费返回的 `results[]`，并保留 `provider` 归因（结果里会标注来自 `search-hub-legacy` 实例）。

## 3. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:44475` | 旧实例地址；网页「搜索源 → 新增」里填写 |
| `config.path` | `/api/search` | 旧 API 路径；网关前缀可用 `/gateway/search` |
| `config.mode` | `rrf` | 传给旧服务的融合模式（`basic` / `rrf` / `deep` 视旧版本支持） |
| Key（可选） | 无 | 旧实例开了鉴权时填；新平台加密存储，界面只显示首 4+末 4 |
| `timeoutMs` | 12000 | 建议 ≥ 旧服务 P95 |
| `freshness` / `language` | 实例默认 | 有值时透传，`all` 不发送 |

### 内网地址与 SSRF 白名单

`safe-fetch` 默认拒绝回环/RFC1918 目标。旧实例在 `127.0.0.1` 或内网时，必须由管理员在 **设置 → 安全 → 私有主机白名单** 显式加入该主机（例如 `127.0.0.1`、`search-hub.internal`）。这是有意的两步操作：不允许仅凭一个 Provider 的 `baseUrl` 就打开内网访问。

## 3.1 三种网络场景：`127.0.0.1` 不是通用答案

默认值 `http://127.0.0.1:44475` 只在“新平台与旧服务跑在同一台机器、且新平台不是容器”时成立。其他情况必须改成对应地址：

| 部署形态 | 正确地址写法 | 说明 |
|---|---|---|
| 新平台原生进程 + 旧服务同机 | `http://127.0.0.1:44475` | 默认值唯一成立的场景 |
| 新平台在 Docker 容器 + 旧服务在**宿主机** | `http://host.docker.internal:44475`（Docker Desktop）或宿主机网关 IP（Linux 常见 `172.17.0.1`，以 `ip route` 为准） | 容器里的 `127.0.0.1` 指**容器自身**，不是宿主机 |
| 新平台与旧服务在**同一 compose 网络** | `http://<service-name>:44475` | 用服务名，不要用 localhost |
| 跨服务器 | `http://<旧服务可达域名或内网 IP>:44475` | 需要网络可达 + 防火墙放行 |
| 旧服务只监听宿主机回环 | 先让旧服务监听容器可达的地址，或用 host 网络模式 | **不要**通过关闭 SSRF 防护来“解决” |

> SSRF 防护不是网络配置的替代品。目标主机必须加入 **设置 → 安全 → 私有主机白名单**（例如 `host.docker.internal`、`192.168.1.20`），这是“明确允许访问内网”的声明；把白名单当成万能开关、或为了连通而关闭校验，都会把内网暴露给任何能改 Provider 配置的人。

### 来源归因

旧服务返回的 `provider` / `providerName` / `source` / `sources` 会原样进入结果的 `upstream` 字段：

- `providerName`（平台层）= **本次通过哪个旧版网关**获得；
- `upstream.provider` / `upstream.sources` = **上游实际来源**，只复制旧服务真实给出的值；
- 旧服务没给就不填，**绝不根据 URL 或域名猜一个来源**。

### 状态映射

| 旧服务信封 | 本平台行为 |
|---|---|
| `status: "completed"` + 结果 | `completed` |
| `status: "completed"` + 0 条 | **合法的空结果**，不是失败 |
| `status: "partial"` | 保留结果，搜索状态为 `partial`，Provider stat 带 `warning` |
| `status: "failed"` | 抛出 provider 错误（绝不当作“成功空数组”）；全源失败时 HTTP 503 + 结构化 `errors` |
| `status: "failed"` + `results: []` | 同上，空数组不能洗白失败 |
| 无 `results[]` 字段 | `bad_request`，明确提示期望的两种信封 |

## 4. 操作步骤（需人工执行）

1. 旧服务保持运行，确认它自己的 `/api/health` 正常（**本轮未执行**）。
2. 新平台「搜索源 → 新增」选择「旧版 Search Hub（兼容）」。
3. `baseUrl` 填旧实例地址；需要时展开高级配置填 `path` / `mode`。
4. 保存后点「测试」——会真实调用一次 `POST {path}`，返回延迟、结果数与 3 条样例。
5. 在「搜索实验室」勾选该源，跑一次真实查询；确认 `provider` 归因显示为这个实例。
6. 需要撤销：删除该 Provider 实例。旧服务不受影响，新平台也不再调用它。

## 5. 错误处理

| 旧服务返回 | 新平台行为 |
|---|---|
| 401 / 403 | `auth_invalid`，Key 暂停，需人工重测（与旧 token 失效语义一致） |
| 429 | `rate_limited` + `Retry-After`，按冷却时间退避 |
| 5xx | `server_error`，指数退避 + 熔断 |
| 超时 | `timeout`（可重试） |
| 调用方取消 | `cancelled`（不可重试，不计入 Key 失败） |
| 响应缺 `results[]` | `bad_request`，明确提示两种期望信封 |

## 6. 验证状态

| 项 | 状态 |
|---|---|
| 适配器实现 | 已完成 |
| 契约测试（23 项） | **PASS**：请求形状、两种信封、字段别名、相对 URL 丢弃、401/403/429/5xx、取消语义、上游归因、failed/partial/empty 状态、未实现 transport 拒绝、注册 |
| API 集成测试（5 项） | **PASS**：归因透传到 `POST /api/search`、failed→503、partial→`status=partial`+warning、取消不冷却 Key、只调用文档路径 |
| 真实旧实例联调 | **未执行**（未获授权连接 44475） |
| 旧服务兼容性（实际版本/字段） | 未知，需在授权后用「测试」按钮确认 |

**结论**：这是一个可上线但默认不启用的兼容能力。在获得明确授权并完成一次真实 44475 联调前，状态保持 `documented`，不得写成「已接入旧版」。
