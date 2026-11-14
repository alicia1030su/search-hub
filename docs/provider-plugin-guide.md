# 如何为 Search Hub 开发一个 Provider 插件

本文写给想接入新搜索源（或数据源）的贡献者。目标：**按官方接口实现、可测试、状态诚实**。

## 0. 先读这条红线

`catalog.ts` 里的 `verification` 字段是唯一支持状态来源：

| 值 | 含义 | 进入条件 |
|---|---|---|
| `live_tested` | 有真实调用记录 | 命令、query、结果 URL、时间戳（不含 Key）都留在报告里 |
| `documented` | 按官方文档实现 | 有官方文档链接；**没有**真实调用 |
| `unverified` | 端点未确认 | 只能是 `planned`，UI 不允许创建 |
| `no_official_api` | 无公开 API | 不允许写爬虫；只能是 `unavailable` |

`planned` → `builtin` 必须同时满足：官方文档链接、错误码映射、Mock/契约测试、**一次真实调用记录**。纯 Mock 通过不算。

## 1. 文件布局

```
packages/providers/src/
  catalog.ts                 # 声明式元数据（不能少）
  registry.ts                # 注册适配器
  http.ts                    # callJson / mapItem / 错误映射（复用）
  builtin/
    <name>.ts                # 你的适配器
```

## 2. 适配器契约

```ts
export const yourAdapter: SearchProviderAdapter = {
  type: "your-name",          // 必须与 catalog.type 一致
  requiresKey: true,          // 有 Key 才能工作就必须为 true
  supportsTest: true,         // 支持"测试"按钮就为 true
  async search(input, ctx) { /* ... */ },
  async test(ctx) { /* ... */ },
};
```

`search` 的输入：

| 字段 | 含义 | 你必须做的 |
|---|---|---|
| `input.query` | 用户查询 | 直接传给厂商 |
| `input.limit` | 期望条数 | 传到厂商的 `count/max_results`，并二次 `slice` |
| `input.language` | BCP-47 语言 | **厂商支持才传**，不支持就不传并写注释，禁止臆造参数 |
| `input.freshness` | `day/week/month/year/all` | 映射到厂商的时间窗参数；无法映射就忽略并注释 |
| `input.signal` | 取消信号 | 交给 `callJson`，不要自己 `setTimeout` |
| `ctx.apiKey` | 解密后的 Key | 只用于注入到请求，**不得**写入日志或返回 |
| `ctx.config.baseUrl` | 自定义地址 | 优先用它，回退到官方默认地址 |
| `ctx.config.config` | 实例级附加配置 | 自定义参数放这里，要校验类型 |

返回值：

```ts
{ results: RawSearchResult[], requestUrl?: string, warnings?: string[] }
```

`RawSearchResult` 只有 `title` 与 `url` 必填；`snippet/publishedAt/score/language` 可选。**必须用 `mapItem`**，它会做 HTML 剥离、URL scheme 校验、长度截断与日期归一化。

## 3. 错误映射（必须逐条覆盖）

| 上游 | 抛出 | 重试 |
|---|---|---|
| 401 / 403 | `ProviderError(..., "auth_invalid")` | 否，Key 置 invalid |
| 429 | `rate_limited` + `retryAfterMs`（从 `Retry-After` 解析） | 是，按冷却 |
| 402 / 配额 | `quota_exceeded` | 否，冷却到次日 |
| 408 / 504 / 网络 | `timeout` / `network` | 是 |
| 5xx | `server_error` | 是 |
| 400 / 422 | `bad_request` | 否 |
| 200 但不是 JSON / 结构不符 | `bad_request` | 否 |

**禁止**把失败当成 `{ results: [] }` 返回。空结果是合法结果，失败必须抛错 —— 否则监控会把故障当"没搜到"。

`callJson` 已经处理了大部分 HTTP 映射；你只需要在响应结构不符时抛 `bad_request`。

## 4. 安全要求

- 只能通过 `ctx.fetch`（SafeFetch）出网。它做 DNS/CIDR 校验、连接期 `lookup` 守卫、逐跳重定向校验、大小上限、超时。
- **不要**自己用 `fetch`/`axios`/`node:https`。那会绕过 SSRF 防护，是安全缺陷。
- 自定义 `baseUrl` 由用户填写，属于不可信输入；不要拼接用户提供的 path、不要把 Key 放进 URL query 后写日志。
- 不要抓取 HTML 页面（除厂商官方文档明确允许）。`no_official_api` 的源不允许爬。

## 5. 契约测试（必须写）

位置：`tests/unit/providers-<name>.test.ts`

最少覆盖：

1. 正常路径：断言请求方法、路径、headers（Key 注入位置）、query/body 参数与官方一致。
2. 结果映射：title/url/snippet/publishedAt 全部来自正确的响应字段。
3. 401 → `auth_invalid`；429 + `Retry-After: 30` → `retryAfterMs=30000`；500 → `server_error`；畸形 JSON → `bad_request`。
4. `baseUrl` 覆盖生效。
5. `language`/`freshness` 映射表逐条断言（不支持时断言"未发送"）。
6. 缺 Key（`requiresKey=true`）→ `auth_invalid` + 可读消息。

用本地 `node:http` 服务器造响应，**不要** mock 掉 `callJson`，否则测不到真实路径。

## 6. 真实联调

```bash
PROVIDER_API_KEY=... pnpm exec tsx tests/scripts/provider-live.mjs --provider <name>
```

- 无 Key：脚本输出 `SKIPPED: no credential`，退出码 **2**（不是 0）。
- 有 Key：跑中文时事 + 英文技术两个查询，打印条数、前 3 条 URL、延迟；URL 必须是 `https://` 且不是 `example.com`；成功输出 `LIVE PASSED` 并退出 0。
- Key 只能来自环境变量，不得写入文件或提交。

拿到输出后：

1. 把 `catalog.ts` 的 `verification` 改为 `live_tested`。
2. `notes` 写清联调日期与范围（不含 Key、不含内网地址）。
3. 在 `docs/provider-matrix.md` 更新状态。
4. 在 PR/Commit 说明里贴结果摘要。

## 7. 注册与文档

1. `catalog.ts` 加条目（`type/name/category/authType/implementation/defaultBaseUrl/docsUrl/description/verification/notes`）。
2. `registry.ts` 加入 `ADAPTERS` 数组。
3. `packages/providers/src/index.ts` 加 `export * from "./builtin/<name>.js"`。
4. `docs/providers.md` 加一节：端点、鉴权、参数映射表、错误码、verification。
5. `docs/provider-matrix.md` 更新总表。

## 8. 语言与时间参数映射：不要发明

各家命名完全不同，且经常缺失：

| 内部 | Tavily | Bocha | Brave | SearXNG |
|---|---|---|---|---|
| language | **无该参数** | **无该参数** | `search_lang` | `language` |
| freshness | `topic=news` + `days` | `freshness`（`oneDay`/`oneWeek`/…） | `freshness`（`pd`/`pw`/`pm`/`py`） | `time_range`（`day`/`month`/`year`） |

"厂商没有这个参数"是常见情况。正确做法是**忽略并写注释**，不是编一个看起来合理的字段名。

## 9. 评审清单

提交前自检：

- [ ] `catalog.ts` 有条目，`implementation` 与 `verification` 匹配真实状态
- [ ] `registry.ts` 已注册，`index.ts` 已导出
- [ ] 只用 `ctx.fetch` 出网
- [ ] 错误映射六类齐全，失败不返回空结果
- [ ] 契约测试 6 项齐全且全绿
- [ ] `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test` 全绿
- [ ] 无 Key、无内网地址、无代理凭证进入仓库
- [ ] 文档与矩阵已更新
