# 搜索源健康管理中心

搜索源有两种**互不相干**的状态。混淆它们是这类系统最常见的谎言来源：

| 概念 | 含义 | 谁决定 | 会因探测成功而改变吗 |
|---|---|---|---|
| **实现验证状态** `implementation.verification` | 这个适配器当初是怎么被验证的：`documented` / `mock_verified` / `live_tested` / `unverified` / `no_official_api` | Provider Catalog（源码常量） | **不会** |
| **运行健康状态** `runtime` | 这个实例**现在**能不能用 | 探测结果 + 凭证可用性 + 管理员开关 | 会 |

因此下面两件事都成立，而且不矛盾：

```
implementation.verification = documented     # 只按官方文档实现，从未真实联调
runtime                     = healthy        # 上一次探测确实成功了
```

一次成功的连接探测**不会**把 `documented` 升级成 `live_tested`。`live_tested` 只能由
`docs/live-evidence/<type>.json` 里的真实请求证据支持（见
[provider-matrix.md](./provider-matrix.md) 的生成规则）。

同样，**没有 API Key 的源永远不是 healthy**：探测在发出请求前就返回 `unverified`，
因为"URL 能解析"不是"能搜索"。

## 一、运行健康状态

| `runtime` | 含义 | 会拦截搜索吗 |
|---|---|---|
| `unknown` | 从未探测，或被管理员重置 | 否 |
| `healthy` | 最近一次探测成功，且有可用凭证 | 否 |
| `degraded` | 有异常但仍可能提供部分服务（5xx、空结果、超时冷却中） | 否 |
| `unhealthy` | 不可用（网络/DNS/TLS 层面失败） | 否 |
| `rate_limited` | 触发厂商频率限制 | 否 |
| `quota_exceeded` | 账户额度耗尽 | **是**（直到冷却结束） |
| `invalid_credentials` | 凭证被厂商拒绝 | **是**（直到冷却结束） |
| `permission_denied` | 403：账号没有该 API 权限 | 否 |
| `cooldown` | 瞬时失败，冷却未到期 | 否 |
| `unverified` | 没有可用凭证 / 无法判断 | 否 |
| `disabled` | 管理员主动禁用 | 是（本就不在搜索范围） |

只有 `quota_exceeded` 与 `invalid_credentials` 会 park 一个源：这两种情况下重试只会
再次失败并可能继续计费。**一次超时、一次 429 都不会移除一个源**——那正是"一次探测
永久杀死一个源"的经典事故。

存储层保留原来的四值 `status`（`provider_health_checks.status`），`runtime` 由
`status + cause + 凭证池 + 冷却` 派生，因此不需要重写历史，也不会因升级而丢失结论。

## 二、Key 健康 ≠ Provider 健康

三层结构：

1. **Key**：某一个 API Key 的状态（`healthy` / `invalid` / `quota_exhausted` / 冷却中）。
2. **Provider 实例**：本页展示的 `runtime`。
3. **Provider 类型**：Catalog 的 `implementation.verification`，与实例无关。

规则：

- 5 个 Key 里坏 1 个 → 实例仍是 `healthy`，`keyAvailable/keyTotal` 显示 `4/5`。
- **全部 Key 被厂商拒绝 → `invalid_credentials`，绝不显示正常**。
- 全部 Key 只是被禁用或在冷却 → `unverified`（无法判断，而不是假装健康）。

## 三、两种探测

| 模式 | `kind` | 请求特征 | 检查内容 | 默认 |
|---|---|---|---|---|
| 连接探测 | `connect` | 一次最小请求（limit=1），**对需要凭证的源也会带上凭证** | DNS、TCP/TLS、鉴权、响应、延迟 | 允许 |
| 真实搜索探测 | `search` | 一次真实搜索（limit=3） | 鉴权、搜索接口、返回结构、是否有真实结果、额度/频率 | 需显式开启 |

**不要把这个页面上的"连接探测"理解成"一定免费"**：它会带着该源的凭证向厂商端点发一次真实请求。
对按请求计费的厂商，这一次也可能计费；本代码无法得知每家厂商的计费口径，所以不宣称免费。
只有**完全不需要凭证**的源（HN / Crossref / OpenAlex / PubMed / arXiv / Wikipedia），连接探测
才确定不会消耗任何账户额度。

探测使用固定的、无隐私的测试词（`test` / `search engine`），**绝不使用用户真实搜索
记录**。

连接探测成功只说明"端点与凭证能建立会话"；只有真实搜索探测拿到结果，才能说这个源
"现在能搜到东西"。

## 四、预算

硬约束，不是建议：

| 限制 | 默认 | 上限 |
|---|---|---|
| 每轮真实搜索探测 | 3 | 200 |
| 每日真实搜索探测 | 20 | 2000 |
| 探测间隔 | 360 分钟 | 5 – 10080 分钟 |
| 并发探测 | 1 | 4 |

- **每日边界是 UTC 00:00**，不是本地时区；接口返回 `budget.day` 让界面直接显示，
  避免"今天"在跨时区部署里产生歧义。
- 连接探测**单独计数**（`connectUsedToday`），不占付费预算。它不设每日上限（设上限会让
  页面无法解释"这个源为什么不可用"），但受两个约束：调度器每 60 秒才 tick 一次，且并发
  上限为 4；手动"检测全部"一次最多触发与源数量相同的请求。
- **无凭证源的真实搜索**单独计数（`anonymousSearchUsedToday`），既不占用付费预算，也不需要
  打开付费开关——它不发送任何凭证，不可能消耗账户额度。之所以单独计数而不是标成"免费"：
  代码无法知道厂商是否按 IP 计量，所以只记录事实，不做"免费"的断言。
- 每日计数**持久化**在 `health_probe_budget` 表，重启不重置；升级到本版本时会用当天
  已有的 `provider_health_checks` 记录**回填**，不会凭空多给一整天。
- 扣减用条件更新（`UPDATE ... SET used = used + 1 WHERE used < max`）实现，
  同一天两个并发探测不可能都通过检查。100 并发探测的上限断言见测试 T18。
- **写不进账本就不发请求**：预算预留失败时，真实搜索探测返回 429，不会"先花钱后补账"。
- 手动探测同样受预算约束，没有后门。
- **取消不退款**：取消可能发生在请求已发出之后，厂商可能已经计费，而本代码无法区分。若取消
  也退款，一个反复中止请求的客户端就能在账本显示 0 的情况下无限消耗额度。只有**确定没发出**
  的探测（没有可用凭证、参数不合法即被拒绝）才退款。
- **多实例不共享预算**：计数在各自进程的 SQLite 文件里，横向扩容时每个实例都有独立的
  每日额度。这是已知限制，不是"全局预算"。
- 每次预留/拒绝都写审计日志（`provider_health.probe`）与结构化日志。

## 五、自动探测与恢复

- **默认关闭**（`scheduledEnabled=false`）。定时器只负责"该不该探测"，是否真的探测由
  每个源的 `nextProbeAt` 决定。
- 调度器每 60 秒 tick 一次，`ticking` 与 `stopped` 两个标志保证：一次 pass 不会与
  自己重叠，进程退出后不会再有新的 pass。
- **每个源独立排期**，不是全局一把闸：
  - 成功 → 按正常间隔安排下一次；
  - 瞬时失败（超时/网络/DNS/TLS/5xx/空结果/限流）→ 指数退避，最短 15 秒，最长不超过
    正常间隔，带 ±20% 抖动；
  - 终态失败（额度、凭证）→ 等正常间隔，提前重试只会再失败一次。
- **恢复**：下一次探测成功即回到 `healthy`，连续失败计数与退避级别清零。
- **单次失败永不永久禁用**；永久移除只有管理员能做的 `disabled`。
- 同一 provider 同时只允许一个探测在飞（`inFlight` 集合），调度与手动检查不会重复打
  同一个源。
- 进程退出时先停调度器、再关数据库；定时器 `unref()`，不会阻止 Node 退出（Windows 上
  这正是服务停不下来的原因）。

## 六、管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/provider-health` | 全部源的运行状态 + 预算 + 汇总 |
| GET | `/api/admin/provider-health/settings` | 当前策略与预算快照 |
| PUT | `/api/admin/provider-health/settings` | 修改策略（Zod 校验 + 上下限） |
| GET | `/api/admin/provider-health/history?providerId=` | 单个源的探测历史 |
| POST | `/api/admin/provider-health/:id/probe` | 手动探测（`{"kind":"connect"\|"search"}`） |
| POST | `/api/admin/provider-health/:id/auto-probe` | 开关单个源的自动探测 |
| POST | `/api/admin/provider-health/:id/reset` | 重置健康状态 |

全部要求 `admin` scope；写操作额外要求 CSRF。`search` scope 的 Token 一律 403——健康
页会暴露"你配了哪些厂商、它们的 Key 还有效吗"。

`/api/admin/health*` 保留为兼容接口，行为不变。

## 七、重置的语义

`POST /api/admin/provider-health/:id/reset`：

- 写入 `provider_probe_state.reset_at`，**早于该时刻的探测记录不再参与状态判定**，
  状态回到 `unknown`，下次探测重新下结论；
- **不删除历史**：删掉失败证据不是重置，是掩盖；
- **不重新启用凭证**：把被厂商拒绝的 Key 通过"重置健康"重新放回池子，等于偷偷开始
  花一笔已经失败过的钱。Key 的状态请在 Key 面板单独处理。

## 八、与缓存、搜索的关系

- 缓存命中**不会**产生探测记录，也**不会**增加任何源的成功计数——缓存是结果快照，
  不是健康证据（测试 T32）。
- 命中缓存时仍会**重新应用当前健康门禁**：被 park 的源依旧出现在响应的
  `failedSources` / `errors` 里，调用方能看到"少了一个源以及为什么"（测试 T35）。
- 用户取消搜索不计为源失败（`errorCode=cancelled` 不计入成功率，也不会写入健康记录）。
- 健康状态变化不影响缓存键与 TTL；缓存键里包含的是当前 park 集合，门禁变化自然导致
  不同的键。
- REST、MCP、Skills 仍然共用同一个 `SearchService`，因此共享同一套门禁。

## 九、凭证类型与健康判断

四种凭证类型必须区分，混为一谈会让页面在两个方向上同时说谎：

| 类型 | 例子 | Key 数量为 0 时 | 能否做真实搜索探测 |
|---|---|---|---|
| 必须凭证，尚未配置 | Brave、Tavily、Exa | `unverified`，**绝不显示健康** | 否（发出前即返回 `no_credential`） |
| 官方完全无需凭证 | Hacker News、Crossref、OpenAlex、PubMed、arXiv、Wikipedia | 正常探测 | 是，且不占付费预算 |
| 需要自建实例 / 额外身份 | SearXNG（需自建实例地址） | 视配置而定 | 仅在实例地址配置完整时 |
| 凭证可选、选择匿名 | 语义上等同"无需凭证" | 正常探测 | 是（不带凭证） |

`GET /api/health` 的 `providers.healthy` 统计的是"启用且可用"，不是"有健康 Key"：后者会把
每一个公开源都算成不可用。实现验证状态仍是另一条轴，一次成功的探测不会改变它。

## 十、数据与迁移

| 表 | 用途 | 迁移 |
|---|---|---|
| `provider_health_checks` | 追加式探测日志（历史） | 0003 |
| `provider_probe_state` | 每源排期：自动开关、连续失败、退避级别、下次探测时间、重置标记 | 0005 |
| `health_probe_budget` | 每日每类探测的持久计数 | 0005 |

迁移 `0005` **只建新表**，不改任何既有表与数据。升级兼容性由
`tests/unit/cache-migration.test.ts` 用真实 SQLite 文件验证：先按旧迁移集建库并写入
管理员、Provider、Key、探测记录与设置，再跑完整迁移，断言逐项不变。
