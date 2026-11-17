# 搜索缓存

缓存持久化在 SQLite 中（表 `search_cache`），与 Providers、Key、搜索历史在同一个
数据库文件里。因此 Docker 数据卷、systemd 重启、Windows 重启都天然保留它，
备份与升级链路也自动覆盖，不需要额外机制。

## 一、缓存键

键是**请求指纹的 SHA-256**（64 位十六进制），不是搜索词本身：

- 用原始搜索词做主键会让这张表变成可读的搜索历史，也撑大索引；
- 键是稳定摘要，日志和数据库里都不会出现用户输入或凭证。

参与指纹的输入（少一个都会导致错误复用）：

| 分组 | 内容 |
|---|---|
| 用户输入 | `query`、`mode`、`capability`、`limit`、`perProviderLimit`、`timeoutMs`、`language`、`freshness` |
| 阶段开关 | `rerank`、`embedding`、`summarize`（含由 mode 推导出的隐式开关） |
| Provider | 每个实例的 `id/type/baseUrl/maxResults/language/freshness/config/search`，以及**凭证版本** |
| 模型 | 实际会使用的 rerank / embedding / chat 模型的 `id + modelId + baseUrl + params + updatedAt` |
| 健康门禁 | 当前被 park 的源列表 |

两条细节：

- Provider 列表按指纹字符串排序后再哈希，请求里传 `[a,b]` 与 `[b,a]` 命中同一条。
- 模型指纹取**解析后的**配置（未指定 id 时取默认模型），所以"换默认模型"也会失效；
  编辑模型行会改 `updatedAt`，同样失效。

**凭证版本**是 `api_keys` 中该 Provider 的 `id/enabled/keyVersion/updatedAt` 的摘要，
不含密文、明文或 hint。新增、删除、禁用或重新加密 Key 都会改变它，从而让用旧凭证
产生的缓存失效。

## 二、有效期（1–72 小时）

- 后台以**小时**输入，1–72 整数，默认 24；存储仍是 `cache.ttlSeconds`（秒），
  避免破坏既有 API 与客户端。
- 校验在服务端对**合并后**的设置执行：
  - 启用时必须在 3600–259200 秒；
  - 关闭时允许 0；
  - 负数、小数、超过 72 小时一律拒绝（不做静默截断，管理员应该被告知）；
  - 关闭状态下填 1–3599 秒同样拒绝，否则重新开启时会立刻全过期。
- 修改 TTL 后会**重算现有记录**：
  - 未过期记录按「创建时间 + 新 TTL」重算，缩短立刻生效；
  - 已经过期的记录直接删除，**不会因为延长 TTL 而复活**。

## 三、自动清理

| 触发 | 时机 |
|---|---|
| 启动时 | 进程启动后立即执行一次 |
| 周期 | 每 10 分钟 |
| 手动 | `POST /api/admin/cache/sweep` |

- 只删 `expires_at <= now` 的记录；
- 有重入保护，慢一次不会叠加下一次；
- 清理异常被吞掉并记日志，不会让进程退出；
- 定时器 `unref()`，并在进程退出时清除；
- **不执行 VACUUM**：SQLite 删除行后文件不会立即缩小，这是正常行为，每次清理都
  VACUUM 只会无谓地阻塞写入。

读路径也会顺带删掉自己命中的过期行，所以即使清理任务还没跑到，也不会返回过期内容。

## 四、容量与淘汰

| 限制 | 值 |
|---|---|
| 最大条数 | 5000 |
| 最大空间 | 256 MB（按 `response_json` 的 UTF-8 字节数求和，不是字符数） |

写入与淘汰在同一事务里：插入/替换后立刻检查总量，超出就按 `last_accessed_at`
升序淘汰（同时间戳用 `created_at` 作为次级排序，保证顺序确定）。并发写入因此也
不会突破上限。

## 五、什么会被缓存

| 情况 | 是否缓存 | 原因 |
|---|---|---|
| 完整成功（`completed`，无 errors，无 failedSources） | 是 | 正常结果 |
| 完整成功但 0 条结果 | 是 | "确实没有"是可复用答案，重复查询只会再花钱 |
| 部分成功（`partial`） | 否 | 把"某个源坏了"回放 24 小时，会掩盖一分钟后恢复的源 |
| 失败（`failed`） | 否 | 没有内容可存 |
| 用户取消 | 否 | 不是关于源质量的证据 |
| 响应带任何 error 条目 | 否 | 同上 |
| `includeRaw=true` | 否（且不读） | 原始响应含供应商内部数据，不应进入对其他调用方可见的表 |

`skipCache=true` 仍然完全绕过：不读、不写，直接打搜索源。

## 六、命中后的行为

- 返回缓存的 `results` / `answers` / `summary` / `failedSources` / `errors` 原始内容；
- 生成**新的 `taskId`** 并写一条 `searchTasks` 记录，状态沿用缓存时的状态
  （缓存的是 `partial` 就仍是 `partial`，不会把成功率算高）；
- `stats.cached = true`，`timing.totalMs = 0`；
- **不调用任何上游 Provider**；
- 重新应用当前健康门禁：缓存只是结果快照，不是健康快照。被 park 的源仍然会出现在
  `failedSources` 里，不会因为历史上成功过而看起来正常。

MCP 工具 `search_web` 的返回值同时带 `cached` 字段，Agent 能区分"新结果"与"回放"。

## 七、统计口径

`GET /api/admin/cache` 返回：

| 字段 | 含义 |
|---|---|
| `entries` / `bytes` | 实时聚合，来自 `search_cache` 表 |
| `maxEntries` / `maxBytes` | 当前生效上限 |
| `hits` / `misses` | 累计，来自 `search_cache_metrics` 的小时桶 |
| `hitRate` | 累计命中率；无查询时为 `null` |
| `hits24h` / `misses24h` / `hitRate24h` | 最近 24 小时（按小时桶求和，跨重启不清零） |
| `expiredRemoved` | 累计清理掉的过期记录数 |
| `evicted` | 累计因容量淘汰的记录数 |
| `lastSweepAt` | 最近一次清理时间，存在 `search_cache_state` 里，重启后仍能显示 |

没有数据时前台显示「暂无数据」，**不会用 0% 冒充**。

## 八、手动操作

| 操作 | 接口 | 说明 |
|---|---|---|
| 立即清理过期 | `POST /api/admin/cache/sweep` | 只影响 `expires_at <= now`，未过期记录不动 |
| 清空全部 | `POST /api/admin/cache/clear`，body 必须含 `{"confirm":true}` | 不可恢复；写审计日志 `cache.clear` |

后台的「清空全部缓存」按钮有二次确认；服务端也要求 `confirm: true`，
所以误触或客户端 bug 都不会真的清空。

## 九、安全边界

- 缓存键是摘要，不含搜索词，也不含任何凭证。
- 缓存行只存响应体。响应本身不包含 API Key、Authorization、Cookie 或密码
  （这些从不进入响应）；`includeRaw` 请求直接绕过持久化缓存。
- 缓存接口全部要求 admin 会话 + CSRF；`/api/mcp/health` 等只读投影不暴露缓存内容。
- 命中不绕过健康门禁，也不会把用户取消记成源失败。

## 十、数据位置与迁移

| 场景 | 缓存是否保留 |
|---|---|
| 服务重启 / systemd restart | 保留（同一 SQLite 文件） |
| Docker `restart` / `down` + `up`（数据卷保留） | 保留 |
| Docker 数据卷被删除 | 丢失，与其它数据一致 |
| 版本升级（含 `0004_search_cache.sql`） | 保留；迁移只建新表，不改旧表 |

升级路径已在 `tests/unit/cache-migration.test.ts` 里用真实 SQLite 文件验证：先按旧
迁移集建库并写入管理员、任务与设置，再跑完整迁移，断言旧数据逐项不变、
`user_version` 推进、新表存在。
