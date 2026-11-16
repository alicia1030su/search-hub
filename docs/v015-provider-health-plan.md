# v0.1.5 开发方案：搜索源健康管理

> 本方案在 beta.6 发布后编写，用于下一阶段实施。不包含新搜索源接入。

## 一、要解决的问题

当前的问题是**「源坏了没人知道」**，不是「源不够多」：

- `documented` 的源（43 个）从没跑过真实请求，用户点进去才发现报错；
- Key 失效（401）、无权限（403）、限流（429）、额度耗尽（quota）在 UI 上是同一条红字；
- 一个源连续失败后仍然被调度，每次搜索都白等一次超时；
- 仪表盘只有「调用次数 / 错误数」，没有「这个源现在还能不能用」；
- 管理员想确认所有源是否健康，只能一个个点「测试」。

## 二、能力清单（对应需求）

| # | 能力 | 落点 |
|---|---|---|
| 1 | 连接自检（DNS/TCP/TLS/HTTP 可达） | `packages/core/src/health/probe.ts` |
| 2 | 真实搜索结果验证（有结果且结构可解析） | 同上，`probe: "search"` |
| 3 | Key 有效性与剩余额度 | `KeyHealth` + provider 特定的 quota 解析 |
| 4 | 401/403/429/quota 分类 | 复用 `ProviderErrorCode`，新增 `quota_exceeded` 来源区分 |
| 5 | 来源健康度评分（0–100） | `health/score.ts` |
| 6 | 自动冷却与故障切换 | 复用 `KeyScheduler` 的 breaker，按健康度调整优先级 |
| 7 | Provider 成功率与 P50/P95 | 由 `search_events` 聚合，新增分位计算 |
| 8 | 实时与历史健康记录 | 新表 `provider_health_checks` |
| 9 | Web「一键测试全部已配置来源」 | `/providers` 页新增批量按钮 |
| 10 | 批量检查的费用预算与请求限制 | `healthPolicy` 设置项 |
| 11 | 自动恢复健康状态 | 冷却到期后由一次轻量探针判定 |
| 12 | 测试凭证脱敏 | 所有响应与日志只出 `prefix` + 指纹 |
| 13 | REST/MCP 故障归因一致 | 同一个 `HealthSnapshot` 供两条协议 |

## 三、数据模型

```sql
CREATE TABLE provider_health_checks (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  key_id        TEXT,              -- 匿名/无 Key 源为 NULL
  kind          TEXT NOT NULL,     -- 'connect' | 'search'
  status        TEXT NOT NULL,     -- 'healthy' | 'degraded' | 'unhealthy'
  error_code    TEXT,              -- auth_invalid / rate_limited / quota_exceeded / ...
  latency_ms    INTEGER,
  result_count  INTEGER,
  health_score  INTEGER,           -- 0-100
  detail_json   TEXT,              -- 脱敏后的诊断信息
  checked_at    TEXT NOT NULL,
  trigger       TEXT NOT NULL      -- 'manual' | 'schedule' | 'recovery'
);
CREATE INDEX idx_health_provider_time ON provider_health_checks(provider_id, checked_at DESC);
```

不新增对 `provider_instances` 的列：健康状态是派生数据，不能与配置混在一起，
否则「最后一次检查失败」会被误当成「这个源被禁用」。

## 四、费用闸门（这是本版最重要的一条）

后台**默认不花任何钱**：

- `healthPolicy.enabled = false`（默认关闭定时检查）
- `healthPolicy.maxRequestsPerRun = 3`（每次批量最多 3 个真实搜索请求）
- `healthPolicy.maxRequestsPerDay = 20`
- `healthPolicy.budgetNote`：仅做连接探测（不发搜索请求）不计费用，默认可开
- 只对**管理员显式点击**或**已配置的定时任务**执行真实搜索探测
- 每次探测前检查当日计数，超限直接返回 `skipped_reason: "budget_exhausted"`
- 无 Key 的源标记 `unverified`，**不生成**健康状态，也不计入健康率

连接探测（`connect`）与真实搜索（`search`）分开记录：前者免费且能区分
「网络不通」与「Key 无效」，后者才花钱。

## 五、错误分类映射

| HTTP / 供应商码 | 分类 | 冷却 | 健康度扣分 |
|---|---|---|---|
| 401 / MiniMax 1004 / 秘塔 2005 | `auth_invalid` | 停用该 Key，源保持可用（若还有其他 Key） | -100（该 Key） |
| 403 / MiniMax 2038 | `blocked`（无权限/未实名） | 30 min | -60 |
| 429 / 带 `Retry-After` | `rate_limited` | 按 `Retry-After` | -30，短暂 |
| 供应商 quota 码 / 余额不足文案 | `quota_exceeded` | 到管理员设定时间或手动解除 | -100（该 Key） |
| 5xx / 超时 | `server_error` / `timeout` | 指数退避 | -20，连续 3 次转 unhealthy |
| DNS/连接失败 | `network` | 5 min | -40 |

`quota_exceeded` 必须与 `rate_limited` 分开：前者再试也不会成功，后者等一会就好。

## 六、编排与前端

- `HealthService.checkOne(providerId, kind, trigger)` → `HealthCheck`
- `HealthService.checkAll({ kind, budget })` → 汇总，**串行 + 间隔**（默认 500ms），
  避免同时打满所有供应商的限流
- `GET /api/admin/health` 返回实时快照；`GET /api/admin/health/history?providerId=`
- `POST /api/admin/health/check`（单个/全部，需 admin + CSRF）
- MCP：`provider_health` 工具返回同一份 `HealthSnapshot`（只读，不触发检查）
- Web：健康列 + 徽章（健康/降级/不可用/未验证）+ 一键测试 + 预算提示

## 七、验收标准

| 项 | 判定 |
|---|---|
| 无 Key 源 | 显示 `unverified`，绝不显示健康 |
| 401 | 该 Key 标记失效，源在还有其他 Key 时仍可用 |
| 429 | 冷却生效，下次调度跳过该 Key |
| 配额耗尽 | 分类为 `quota_exceeded`，不被误判为限流 |
| 预算 | 超过 `maxRequestsPerDay` 后返回 `skipped`，不发请求 |
| 脱敏 | 任何响应/日志不含完整 Key（用 secret-scan 与快照测试双重校验） |
| 一致性 | 同一次检查在 REST 与 MCP 中的 `status`/`error_code`/`health_score` 完全一致 |
| 恢复 | 冷却结束后一次轻量探针可将 `unhealthy` 恢复为 `healthy` |

## 八、明确不做

- 不新增搜索源（本版只做健康管理）
- 不做后台默认真实搜索（默认关闭，需显式开启并设预算）
- 不为无 Key 的源伪造健康状态
- 不把健康检查结果写进缓存键（健康是运行态，不是结果语义）
