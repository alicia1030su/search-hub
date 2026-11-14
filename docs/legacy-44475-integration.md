# 旧版 Search Hub（44475）兼容接入方案

日期：2026-11-14 ｜ 状态：**适配器已实现、契约测试通过、未连接任何真实旧实例**

## 1. 目标与边界

| 目标 | 做法 |
|---|---|
| 旧服务保持独立运行 | 不改旧服务、不迁移数据、不复制凭据、不重启 |
| 新平台把旧服务当作一个搜索源 | 新增 `search-hub-legacy` 适配器，走旧服务的 REST 搜索接口 |
| 可测试 | 本地 fake 服务覆盖请求/响应/错误映射（`tests/unit/providers-legacy.test.ts`，16 项） |
| 可撤销 | 删除新平台里的这个 Provider 实例即可完全回滚，无残留 schema/任务/密钥 |
| 不影响生产数据 | 只发 `POST {path}` 读结果，不写入旧服务；新平台的搜索历史另存本地 |

**未做且需要单独授权**：连接、探测、修改或重启任何真实旧实例。

## 2. 接入架构

```text
新平台 Search Hub
  └─ Provider instance: type=search-hub-legacy
       └─ POST http://<old-host>:44475/api/search
            body: { query, mode:"rrf", limit, freshness?, language? }
            header: Authorization: Bearer <old token>（可选）
       ← { results:[...] } 或 { data:{ results:[...] } }
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
| 契约测试（16 项） | **PASS**：请求形状、两种信封、字段别名、相对 URL 丢弃、401/403/429/5xx、取消语义、注册 |
| 真实旧实例联调 | **未执行**（未获授权连接 44475） |
| 旧服务兼容性（实际版本/字段） | 未知，需在授权后用「测试」按钮确认 |

**结论**：这是一个可上线但默认不启用的兼容能力。在获得明确授权并完成一次真实 44475 联调前，状态保持 `documented`，不得写成「已接入旧版」。
