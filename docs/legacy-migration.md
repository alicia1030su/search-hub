# 从旧 Search Hub 迁移

面向已经在运行旧 Search Hub MCP（二十多个搜索后端）的部署者。目标是**把配置搬过来，而不是把密钥搬过来**。

## 结论先行

| 旧后端类型 | 推荐接入方式 | 密钥处理 |
|---|---|---|
| 旧兼容网关（Search Gateway / Alt Search Gateway / Premium / ORZ Fetch / Union Free / Zhihu Radar / GPT55） | `generic-http` 声明式映射，指向网关的搜索端点 | 在新实例 UI 重新录入；迁移工具不读取、不传输、不落盘 |
| 旧实例里包着的官方源（Brave / SearXNG） | 原生适配器 | 同上 |
| 未知厂商但暴露 HTTP JSON 搜索 | `generic-http`，由迁移计划生成模板 | 同上 |
| 只有模型能力、没有搜索端点 | 不迁移 | — |

迁移过程**不会连接、不会修改旧服务器**。输入是旧实例导出的 JSON（或手工整理的清单），输出是"计划 + 可执行导入"。

## 迁移步骤

### 1. 导出旧实例的源清单（不含密钥）

在旧实例上导出 `name / type / baseUrl / enabled / limits / mapping` 这些字段即可。若旧导出包含 `apiKey`/`token`/`key` 字段，**不要删除后再上传**——迁移接口本身会忽略它们，但更稳妥的做法是先本地剔除。

```json
{
  "providers": [
    { "name": "search-gateway", "type": "search-gateway", "baseUrl": "https://gateway.internal/api" },
    { "name": "brave-main", "type": "brave" },
    { "name": "zhihu-radar", "type": "zhihu-radar", "baseUrl": "https://radar.internal" }
  ]
}
```

### 2. 先 dry-run

```bash
curl -sS http://127.0.0.1:8787/api/admin/migration/legacy \
  -H "cookie: sh_session=$SESSION" \
  -H "x-csrf-token: $CSRF" \
  -H "content-type: application/json" \
  -d @legacy-export.json | jq
```

默认 `mode` 是 `dry_run`，只返回计划：

- `items[].decision`：`compat-gateway` / `generic-http` / `builtin` / `skipped`
- `items[].reason`：为什么这样映射，或为什么跳过
- `items[].requiresKey`：是否需要在 UI 重新录入 Key
- `keysRequired[]`：需要补 Key 的源名

计划只包含脱敏后的端点（`scheme://host`），不会回显路径、查询串或任何凭据。

### 3. 确认后导入

```bash
curl -sS http://127.0.0.1:8787/api/admin/migration/legacy \
  -H "cookie: sh_session=$SESSION" \
  -H "x-csrf-token: $CSRF" \
  -H "content-type: application/json" \
  -d '{"mode":"apply","confirm":"IMPORT LEGACY PROVIDERS","payload":'"$(cat legacy-export.json)"'}'
```

规则：

- 必须显式提供 `confirm`，否则 400。
- **同名源一律跳过**，不覆盖、不改名、不重复创建。需要第二实例时，先在导出里改名。
- 导入的源默认 `enabled=true`，但**没有 Key**；在 UI 的 Key 面板逐个添加并点"测试"通过后才会真正参与搜索。
- 全程写审计日志（`migration.legacy.preview` / `migration.legacy.apply`），不含密钥。

### 4. 为每个源补 Key 并验证

1. **搜索源 → 对应源 → Key 管理 → 添加**。
2. 点 **测试**：失败会显示 `auth_invalid` / `blocked` / `timeout` 等具体原因。
3. 在**搜索实验室**单独勾选该源跑一次，确认返回真实结果。
4. 全部通过后再启用多源组合。

## 兼容网关的映射假设

旧兼容网关通常形如 `GET {baseUrl}/search?q=...&key=...`，返回 `{ results: [...] }`。迁移工具据此生成：

```json
{
  "method": "GET",
  "path": "/search",
  "keyInjection": { "in": "query", "name": "key" },
  "resultsPath": "results",
  "mapping": { "title": "title", "url": "url", "snippet": "snippet", "publishedAt": "publishedAt" }
}
```

如果旧网关不是这个形状，在 dry-run 结果的基础上改 `config`，或直接在 UI 用 **通用 HTTP/JSON** 配置。字段映射支持 `a.b[0].c`，不执行任何代码。

## 安全属性（可验证）

| 属性 | 实现 | 测试 |
|---|---|---|
| 不读取凭据 | 只读取白名单字段；`apiKey`/`key`/`token` 被忽略 | `legacy-migration.test.ts` 断言含密钥的 payload 不出现在响应、DB、配置中 |
| 不覆盖旧配置 | 同名跳过 | 第二次 apply 创建 0 条 |
| 不连接旧服务器 | 只处理请求体，无出站请求 | 代码审查；无 fetch 调用 |
| 密钥不落盘 | 不创建 `api_keys` 行 | 导入后 `SELECT COUNT(*) FROM api_keys` = 0 |
| 计划可审计 | `mode`、`decision`、`requiresKey`、`keysRequired` | 接口返回 + 审计日志 |

## 已知限制

- 旧实例若只暴露 MCP 工具而没有 HTTP 管理接口，无法自动导出清单；需要人工整理上面的 JSON。
- 旧网关的鉴权若不是 query key（例如自定义签名、mTLS），需要手写 `headers` 或改用单独的 Provider Adapter。
- 迁移不校验旧网关是否仍在线；"测试"按钮才是连通性判据。
