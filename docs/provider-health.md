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

同样，**需要凭据但没有可用凭据的源不会显示 healthy**；完全免 Key 的公开源可以正常探测，
其健康状态来自真实请求结果，而不是"URL 能解析"。

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

额度耗尽、无效凭证与权限拒绝会停用对应 Key 或账户组；其中 `quota_exceeded` 与
`invalid_credentials` 会 park 一个源，因为重试只会再次失败并可能继续计费。
**一次超时、一次 429 都不会移除一个源**——那正是"一次探测永久杀死一个源"的经典事故。

存储层保留原来的四值 `status`（`provider_health_checks.status`），`runtime` 由
`status + cause + 凭证池 + 冷却` 派生，因此不需要重写历史，也不会因升级而丢失结论。

## 二、Key 健康 ≠ Provider 健康

三层结构：

1. **Key**：某一个 API Key 的状态（`healthy` / `invalid` / `forbidden` / `quota_exhausted` / 冷却中）。
2. **Provider 实例**：本页展示的 `runtime`。
3. **Provider 类型**：Catalog 的 `implementation.verification`，与实例无关。

规则：

- 5 个 Key 里坏 1 个 → 实例仍是 `healthy`，`keyAvailable/keyTotal` 显示 `4/5`。
- **全部 Key 被厂商拒绝 → `invalid_credentials`，绝不显示正常**。
- 全部 Key 只是被禁用或在冷却 → `unverified`（无法判断，而不是假装健康）。

## 三、两种探测

| 模式 | `kind` | 请求特征 | 检查内容 | 默认 |
|---|---|---|---|---|
| 连接探测 | `connect` | 解析后的最小搜索计划；分页/重定向按**物理 HTTP 跳**计量 | DNS、TCP/TLS、鉴权、响应、延迟 | 允许，受连接预算约束 |
| 真实搜索探测 | `search` | 一次真实搜索（limit=3） | 鉴权、搜索接口、返回结构、是否有真实结果、额度/频率 | 需显式开启 |

**不要把这个页面上的"连接探测"理解成"一定免费"**：它会带着该源的凭证向厂商端点发真实请求。
对按请求计费的厂商，这一次也可能计费；本代码无法得知每家厂商的计费口径，所以不宣称免费。
结果与 `detail_json` 明确返回 `billingUnit:"unknown"`，物理跳数只是本地安全预算单位。
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
| 每轮付费真实搜索探测 | 3 | 200 |
| 每日付费真实搜索探测 | 20 | 2000 |
| 每轮匿名真实搜索探测 | 3 | 200 |
| 每日匿名真实搜索探测 | 20 | 2000 |
| 单次连接探测物理 HTTP 跳 | 5 | 20 |
| 每日连接探测物理 HTTP 跳 | 50 | 2000 |
| 探测间隔 | 360 分钟 | 5 – 10080 分钟 |
| 并发探测 | 1 | 4 |

- **每日边界是 UTC 00:00**，不是本地时区；接口返回 `budget.day` 让界面直接显示，
  避免"今天"在跨时区部署里产生歧义。
- **连接探测按物理 HTTP 跳单独计数**（`connectUsedToday`），不占付费搜索预算。
  每次分页、重试或重定向在实际发出前于 fetch 边界条件预留一跳，默认单次最多 5 跳、
  每日最多 50 跳（UTC）。本地预算不足返回 `429 quota_exceeded`，不写健康/计费行、
  不失效 Key、不停用源；批量任务记 `SKIPPED_BUDGET`。这是 v0.1.12 起生效的硬上限。
- **无凭证源的真实搜索**单独计数（`anonymousSearchUsedToday`），使用独立的
  `anonymousMaxRequestsPerRun/Day`（默认 3 / 20），既不占用付费预算，也不需要打开付费开关。
  之所以单独计数而不是标成"免费"：代码无法知道厂商是否按 IP 计量，所以只记录事实。
- 判定“是否使用凭据”以 `providerRequiresKey(type, config)` 为准；generic-http 配置了
  `keyInjection` 或 `{{key}}` 时属于需凭据源。可选 Key 池存在不会自动把免 Key 源变成付费源。
- 每日计数**持久化**在 `health_probe_budget` 表，重启不重置。迁移 `0009` 先归档旧桶，再从
  `provider_health_billing.budget_day/spent` 一次性重算；只有 `spent=true` 的记录计入，旧的匿名
  历史必须有精确分类才计入匿名，其余保守计入付费，不会凭空多给一整天。
- 扣减用条件更新（`UPDATE ... SET used = used + 1 WHERE used < max`）实现，
  同一天两个并发探测不可能都通过检查。100 并发探测的上限断言见测试 T18。
- **写不进账本就不发请求**：预算预留失败时，真实搜索探测返回 429，不会"先花钱后补账"。
- 手动探测同样受预算约束，没有后门。
- **退款以真实物理请求数为准**：`requests=null/0` 证明探测没有离开进程，此时按预留时记录的
  `budget_day` 退还对应付费/匿名槽位，并写 `spent=false`。即使探测跨过 UTC 午夜，也不会退到
  新的一天。`requests>0` 时取消或失败都不退款，因为厂商可能已经计费。
- **精确计费侧表**：`provider_health_billing` 记录 `budget_kind`、`budget_day`、
  `classification`、`credential_used` 与 `spent`。升级回填只统计 `spent=true` 的记录；旧的匿名
  桶只有在历史分类可证明时才计入匿名，其余保守计入付费。连接桶按健康行
  `detail_json.requests` 汇总物理跳数；结果中的 `billingUnit` 始终为 `unknown`。
- **GET 健康读取只读**：批量预检、概览、设置与 MCP 健康读取不写健康、计费、预算、任务、
  设置或审计表。账本行缺失时只在内存中从 `spent=true` 的计费行计算，不物化账本。
- **多实例不共享预算**：计数在各自进程的 SQLite 文件里，横向扩容时每个实例都有独立的
  每日额度。这是已知限制，不是"全局预算"。
- 管理端探测请求的成功/拒绝会写审计日志（`provider_health.probe`）与结构化日志；健康 GET 读取不写审计。

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
- **每个源在同一进程内同时只允许一个探测在飞**。单源测试、Key 测试、`checkMany`、定时巡检与
  批量 runner 全部经过同一个 `HealthService.probeWithLock`，不存在第二套 `inFlight` 集合。
  手动/单源重复请求得到 `409 already_running`；`checkMany` 与批量 runner 把它记为跳过
  （`code:"already_running"`、`checkId:null`），不重复请求、不算失败。100 个并发单源调用只能有
  一个拿到锁，其余 99 个在预算与上游工作之前被拒。
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
| GET | `/api/admin/provider-health/batch-test/preview?kind=&providerIds=&includeKeyless=` | 批量检测预检（只读，`includeKeyless` 缺省 false） |
| POST | `/api/admin/provider-health/batch-test` | 创建批量检测任务 |
| GET | `/api/admin/provider-health/batch-test/:jobId` | 读取进度与逐源结果（只读） |
| POST | `/api/admin/provider-health/batch-test/:jobId/cancel` | 取消任务 |

全部要求 `admin` scope；写操作额外要求 CSRF。`search` scope 的 Token 一律 403——健康
页会暴露"你配了哪些厂商、它们的 Key 还有效吗"。

所有 GET 路由（批量预检、概览、设置、历史）以及 MCP `get_provider_health` 都是只读的：
不创建预算、计费、健康、任务或审计行。设置 PUT 的
`connectMaxRequestsPerProbe/Day` 越界返回 400，不做静默夹取。

`/api/admin/health*` 保留为兼容接口，行为不变。

## 六之二、批量检测

管理员点一次「全部测试」得到的东西有三步，每一步都能看清再决定。

### 资格判定矩阵

判定自上而下，**命中即停**。顺序本身是优先级：从最绝对、最便宜、最不可协商的事实判到
最可配置的偏好，这样一次冷却永远不会被报成"缺 Key"。

| 序 | 条件 | 代码 | 入队 | 计入成功率分母 |
|---|---|---|---|---|
| 1 | `enabled=false` | `SKIPPED_DISABLED` | 否 | 否 |
| 2 | `getAdapter(type)` 为空 | `CONFIG_ERROR` | 否 | **是（算失败）** |
| 3 | 调度器冷却未到期 | `SKIPPED_COOLDOWN` | 否 | 否 |
| 4 | `requiresKey` 且全部启用 Key 无法解密 | `CONFIG_ERROR` | 否 | **是（算失败）** |
| 5 | `requiresKey` 且一条 Key 都没填 | `SKIPPED_NO_KEY` | 否 | 否 |
| 6 | `requiresKey` 且 Key 全部被禁用 | `SKIPPED_NO_ENABLED_KEY` | 否 | 否 |
| 7 | 账户组配额耗尽 | `SKIPPED_ACCOUNT_QUOTA` | 否 | 否 |
| 8 | 全部 Key 冷却 / 额度耗尽 / 失效 / 不可用 | `SKIPPED_COOLDOWN` / `SKIPPED_QUOTA_EXHAUSTED` / `SKIPPED_INVALID_KEY` / `SKIPPED_NO_USABLE_KEY` | 否 | 否 |
| 9 | `!requiresKey` 且本任务未开启「包含免 Key 来源」 | `SKIPPED_KEYLESS_BY_POLICY` | 否 | 否 |
| 10 | 付费搜索且付费开关关闭 | `SKIPPED_PAID_DISABLED` | 否 | 否 |
| 11 | 对应付费/匿名预算耗尽 | `SKIPPED_BUDGET` | 否 | 否 |
| 12 | 以上都不命中 | `ELIGIBLE` | 是 | 是 |

两点必须说清楚：

- **付费开关只影响需凭据的搜索源。** 混合任务里这些源记 `SKIPPED_PAID_DISABLED`，匿名源继续；
  只有纯付费范围才在创建任务时返回 409 `validation_error`。仅匿名范围始终允许启动。
- **预算按真实类别分开。** 需凭据源看付费额度，免 Key 源看匿名额度；无 Key 的需凭据源先报
  `SKIPPED_NO_KEY`，不会被笼统报成预算耗尽。
- `kind=connect` 不看付费/匿名**搜索**额度；generic-http 的匿名连接探测执行真实搜索，仍计入匿名桶。
  内建连接探测在 fetch 边界检查单次/每日物理跳预算；本地拒绝在 runner 中落为 `SKIPPED_BUDGET`，
  而不是 `CONFIG_ERROR` 或厂商失败。批量预检不会为连接任务预留或写入预算。

### 统计口径

- `total` = 范围内来源总数，**包含**被跳过的源（否则 UI 无法显示"跳过 8"）。
- `skipped` = 所有 `SKIPPED_*` 来源，**不进分母、不计失败**。
- `testable` = `total - skipped`，**含** `CONFIG_ERROR`（它在预检阶段即判失败，但确实被检测过）。
- `done` = `ok + failed + pending`；`pending` 就是 `empty_results`。
- 成功率 = `ok / testable`。
- 恒等式（进测试）：`done + skipped + remaining === total` 且 `ok + failed + pending === done`。
- 预检的 7 个计数之和 **等于** `total`：冷却、额度、账户配额与付费策略跳过共用
  `coolingSkipped` 一列，逐条 `code` 仍然区分具体原因。

### 错误分类（对外 14 个规范名）

存储层沿用既有 `HealthCause`，对外经一张固定映射表转换，**不新增枚举值**。
`already_running` 是批量 runner 的跳过码，不是 `HealthCause`，因为它表示"另一条路径正在测"，
本次运行没有得出任何健康结论。

| 对外 | 存储 `cause` | 算失败 |
|---|---|---|
| `auth_invalid` | 同名 | 是 |
| `forbidden` | 同名 | 是 |
| `rate_limited` | 同名 | 是 |
| `quota_exceeded` | 同名 | 是 |
| `timeout` | 同名 | 是 |
| `dns_error` | `dns` | 是 |
| `tls_error` | `tls` | 是 |
| `network_error` | `network` | 是 |
| `invalid_response` | `bad_response` | 是 |
| `empty_results` | 同名 | 待确认（计入已完成，不进分子） |
| `configuration_error` | `config_incomplete` | 是 |
| `server_error` | 同名 | 是 |
| `cancelled` | 同名 | 否（不写健康行） |
| `no_credential` | 同名 | 否（`unverified`） |

`forbidden | rate_limited | quota_exceeded` 在 UI 里归为「**受限**」一组：它们都"没成功"，
但重试不会变好（限流重试只会再失败一次并再花一次请求）。「只重测失败项」**不含**受限，
也不含待确认（`empty_results` 已有独立按钮）。

### 结果表与刷新后的回看

结果表按需求规定的 8 列呈现：来源（名称 + 适配器类型）/ 状态 / API Key（**已配置数量**，
不是 Key 本身）/ 耗时 / 结果数量 / 错误原因 / 最近检测 / 操作（详情、重测）。分类与
上游请求数放在详情抽屉里——那里有空间把分类、建议、样例和实测请求数一起读清楚。
任何未测量的字段显示 `—`，绝不用 `0` 冒充一次测量。

「全部测试」在**搜索源页面顶部**和健康 tab 各有一个入口：两者打开的是同一个预检流程、
同一套资格规则，不存在第二个实现。

开始一个任务后，浏览器会记住一个**指针**（job id、kind、开始时间，不含任何结果或凭证）。
刷新页面时，页面拿这个指针去问服务端"这个任务现在是什么状态"，并在标签栏上方显示一行提示：

- 仍在运行 → 「上次检测仍在进行（已完成 x/共 y）」+「查看进度」，每 2 秒更新；
- 已结束 → 「上次检测已结束（completed / 部分完成 / 已取消 / 已中断）」+「查看结果」；
- 404（任务已不存在）或 403（属于另一个账号）→ **静默清除指针**，不报错、不显示提示条。

提示条不会在页面加载时自动弹窗；关掉提示条只影响这一次浏览，指针保留，下次刷新仍可回看
同一个任务。指针是浏览器本地的：换一个浏览器不会看到上次任务的快捷入口（任务本身仍可
通过 API 读取）。

### 取消与 `interrupted` 的语义

- **取消是原子事务**：同一事务内重读 `running` 行，把所有 `unknown` 项改为
  `SKIPPED_CANCELLED`，重算全部计数，再写 `cancelled`、`finishedAt` 与 `itemsJson`；
  提交后才 abort 任务级 `AbortSignal`，不等待 runner 收尾。已完成的条目保持不可变。
  取消不写健康行；预算是否退还取决于 `requests`：为 0 时按原 `budget_day` 退款，大于 0 时保留。
- **取消的 abort reason 带 `code:"cancelled"`**，否则 `classifyError` 的 `/aborted/i`
  兜底会把它判成 `timeout` 并给源写一条降级记录——这是最容易踩的坑，runner 侧另有一道
  `detached.cancelled()` 兜底。
- **`interrupted`**：进程被 kill 时，行仍是 `running`。下次启动由
  `ProviderBatchService` 构造函数在事务内把遗留 `unknown` 项改为 `SKIPPED_INTERRUPTED`，
  重算计数并写 `interrupted`/`finished_at`。第二次执行匹配 0 行；终态读视图保证
  `remaining=0`，因此重启后永远不会读成 `completed` 或永久 running。
- 正常收尾写 `completed`，异常收尾写 `partial`；两者都在事务内重读且只终结仍为 `running`
  的行。`cancelled` 永远不会被旧 runner 覆盖成 `completed`。UI 以状态与 `remaining=0` 共同判断 settled。

### 上游请求数从哪来

`checkOne` 在探测前包一层 `countedFetch`，从 `SafeFetchInit.onRequest`（**每个物理请求
含重定向**都会触发）累加计数，写进 `detail_json.requests` 与返回体。没发请求（无凭据、
提前失败）时为 `null`，UI 显示 `—`；**禁止**用 `ceil(limit/pageSize)` 或计划页数推算。

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

## 十、凭据泄漏边界（v0.1.12）

URL query 中的 API Key 曾通过厂商错误正文、HTML 错误页、编码回显、错误 `details.url`、
SQLite 健康历史、Key `last_error_message`、审计详情与 MCP 健康输出泄漏。现在统一规则是：

- 已知敏感参数名（`api_key`、`apikey`、`key`、`token`、`access_token`、
  `client_secret`）按字面量与百分号编码匹配并替换为 `[redacted]`。
- 自定义 generic-http query 注入名按本次请求的精确 Key 值清洗，覆盖 URL 编码、form
  编码与双重编码；不依赖参数名恰好叫 `key`。
- `q`、`engine`、`page` 等非敏感参数保留，便于排障；诊断 URL 与错误 `details.url`
  使用同一清洗器。健康 GET 读取不会把旧账本物化或产生新审计记录。

## 十一、数据与迁移

| 表 | 用途 | 迁移 |
|---|---|---|
| `provider_health_checks` | 追加式探测日志（历史）；`batch_id` 指向产生它的批量任务 | 0003 / 0008 |
| `provider_probe_state` | 每源排期：自动开关、连续失败、退避级别、下次探测时间、重置标记 | 0005 |
| `health_probe_budget` | 每日每类探测的持久计数（`connect` / `search` / `search_anonymous`） | 0005 / 0009 / 0010 |
| `health_probe_budget_connect_legacy` | v0.1.11 及更早的原始 `connect` 计数归档，供审计与恢复 | 0010 |
| `provider_health_billing` | 每次真实搜索/连接探测的精确计费分类、是否使用凭据、是否实际发出请求 | 0009 |
| `provider_test_batches` | 批量检测**任务台账**：进度、逐源状态、起始预算与任务级策略快照 | 0008 |

**`provider_test_batches` 不是第二套健康表。** 健康事实只有 `provider_health_checks`
一个来源；任务台账只回答"这次跑到哪了"。删除一条台账不会改写任何健康历史。

`requests` 存放在 `provider_health_checks.detail_json`（`{"requests": n}`），
没有新增主表列——避免为了一个观测字段再动一次主表。

迁移 `0005` **只建新表**，不改任何既有表与数据。迁移 `0008` 给
`provider_health_checks` 加可空 `batch_id` 并新建台账表。迁移 `0009` 新增精确计费分类表与
`spent` 事实，把旧预算桶归档后按可审计记录一次性重算，之后的新预留直接写独立账本桶。
迁移 `0010` 把原始 `connect` 桶复制到 `health_probe_budget_connect_legacy`，再从
`provider_health_billing`（`spent=1`）关联 `detail_json.requests` 重算：缺失、0 或非法值
保守按 1 跳，`max(current,recomputed)` 保证只增不减，重复执行不会改变结果。
迁移 `0011` 给诊断增加 sanitized 标记：旧行默认 false，读取时 withheld；新行显式 true，
继续做精确 Key 脱敏。旧诊断原文不修改、不删除。
升级兼容性由 `tests/unit/cache-migration.test.ts`、`tests/unit/quality-migration.test.ts`、
`tests/unit/batch-migration.test.ts` 与 `tests/unit/connect-budget-migration.test.ts` 用真实
SQLite 文件验证；v0.1.12 的运行时契约另由 `health-connect-budget.test.ts`、
`health-probe-lock.test.ts`、`provider-query-key-redaction.test.ts` 与
`provider-preview-readonly.test.ts` 覆盖。
