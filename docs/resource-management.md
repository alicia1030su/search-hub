# 资源管理与缓存维护（v0.1.14）

本文定义 Search Hub 开发、验证和发布阶段的资源口径。目标是在资源不足时调整调度，而不是缩减测试、弱化断言或伪造通过结果。实现状态以对应命令的真实退出码和 `artifacts/v0.1.14/<runId>/summary.json` 为准。

## 1. 资源检查

在任何大规模测试、构建或并行子 Agent 启动前，先检查宿主机**当前可用物理内存**；不能只看总内存、Node heap 或历史空闲值。

```bash
pnpm resource:doctor
pnpm resource:doctor --json --include-processes
```

正式采集器应区分：

- Linux：`/proc/meminfo` 的 `MemTotal`、`MemAvailable`、Swap、page cache；cgroup v1/v2 的 limit/current/OOM；`/proc/<pid>/status` 的 RSS。
- Windows：Koffi 直接调用 `GlobalMemoryStatusEx`、`GetSystemTimes`、Toolhelp 与 `GetProcessMemoryInfo`；不得使用 WMIC，也不得借 Bash 调用 PowerShell 或绕过执行策略。
- Node：`process.memoryUsage()` 的 heapUsed/heapTotal/external/arrayBuffers；OS RSS 与 V8 heap 分开。
- 非 Node 进程：heap 为 `null`，`source` 与 `reason:"not_node"` 明确，不能填 0。

未知值一律为 `null + {source,reason}`；bytes 为整数，耗时 ms 为整数，日期使用 ISO UTC。报告不包含 token、Key、cookie、搜索正文、Provider 配置、SQL、完整 argv 或 env。

## 2. 低内存策略与 worker 配置

```bash
pnpm verify:smart
pnpm test:lowmem
```

`verify:smart` 的固定顺序是 typecheck → lint → Vitest → build → Playwright。阶段间串行，重型阶段共享互斥锁；只有 Vitest 阶段允许预算内受控并行，build/Playwright 始终串行。

- 有效预算取宿主机可用内存与 cgroup 正上限余量的保守最小值；Swap/pagefile 只报告，不计入可分配工作内存。
- 保留宿主机与 cgroup safety floor；`baselineHeadroom < fixed + 1 worker` 时返回 `blocked_insafe_budget`，不启动子进程。
- `vitestWorkers = clamp(floor((baselineHeadroom-fixedMiB)/peakMiB),1,min(logicalCpus,8))`；未取得 D05 真实曲线时峰值必须标 `estimated:true`。
- 压力级别为 normal → warn → high → danger → stop；warn 减少下一批/阶段并发，high 不启动新 worker，danger 停止新阶段并仅清理可证明归属的 owned 树，stop 不启动/立即停止。
- `test:lowmem` 使用 `--maxWorkers=1 --no-file-parallelism`，但必须执行完整 Vitest，并以 `vitest list --json` 比较 file + fullName 并集。skip、todo、failed、范围差异、启动失败和残留均不得隐藏。
- **`verify:smart` 和本地 lowmem 不替代 CI 的完整 `pnpm test`。** 不得删测试、缩小 include、跳过 fixture、降低断言或提高超时来掩盖 OOM。

## 3. OOM 根因分类

单次 OOM、SIGKILL、exit 137、exit 1、超时或断言失败都不能自动归因于产品内存泄漏。必须先形成证据链：

1. cgroup `memory.events.oom_kill` 增量且 owned 子进程同期死亡；
2. 明确 V8 heap FATAL 并伴随 SIGABRT/非 0；
3. Windows `0xC0000017` 或 `0xC000009A` + owned root death + 明确 memoryLog，且 ownedPeakBytes>0 才确认；peak 未知或无 memoryLog 一律不确认，只保留 possible/clues；
4. 用 stub/故障注入验证分类器，避免仅凭全局事件重试。

根因分类至少包括：宿主/cgroup 容量不足、并发估算失真、V8 old space 上限、外部/ArrayBuffer/native 增长、OS/其他进程竞争、测试数据累积、浏览器进程树、无法归属。只有首次**确认 OOM**且 Vitest workers>1 才允许同阶段 workers-1 重试一次；保留首次日志/退出码/峰值，第二次失败即阻断。其他已串行阶段不虚构降并发。

## 4. owned 进程清理

spawn 前登记 root PID、startTime、祖先链、cwd 和非敏感参数摘要。采样只收录可追溯到 root 的进程；清理前再次核对 PID、startTime 和祖先关系，防止 PID 复用。无法证明归属时只报告，不 kill。成功、失败、OOM、信号和 spawn 失败都必须在 finally 清理 owned 树、HTTP server、DB handle、timer 与 Singleflight。

严禁按进程名批量 kill、杀用户进程、重启、修改 Swap/pagefile、修改 Docker/WSL 全局配置。残留写入 `residual-processes.json`，owned 残留即失败。退出证明只能使用完整、无 limit 截断的 `listProcessPidsStrict`；正常 ancestry 采样使用完整 `listProcessesStrict`，全局枚举失败抛错，单个 PID 详情失败仍保留 PID/可用 ppid，startTime 不可证明的新 descendant 不登记。快照友好 `listProcesses()` 的空数组不能证明进程已退出。

## 5. 缓存管理

```bash
pnpm cache:inspect
pnpm cache:prune --dry-run
```

inspect/dry-run 必须零删除。固定允许列表仅包含工具自有 `.cache/search-hub-resource/v1/<runId>/`（owner manifest）、显式配置的 `.cache/vitest/`、显式配置且有 owner manifest 的 `.cache/esbuild/`、构建配置明确生成的精确 `*.tsbuildinfo`。

永久保护仓库及祖先/子工作区/worktree、`node_modules`、pnpm store、Playwright 浏览器/报告、数据库及 `-wal/-shm`、`master.key`、备份、`.data/data`、生产 `search_cache`、共享缓存、`dist/package`、发布证据、`.resource-bench/` 和未知路径。禁止执行 `git clean -fdx` 代替授权清理，也不得无证据清理用户缓存或工作区。

apply 必须同时提供 `--plan`、`--confirm planId`、`--authorize-delete`；交互模式还需明确短语。计划 15 分钟过期，apply 前重算并比对路径/数量/大小/mtime/类型/保护项；漂移即拒绝。只删计划文件，叶子优先，只删空目录，无 `force-all`。

## 6. Windows / Linux 差异

| 项目 | Linux | Windows |
|---|---|---|
| available | `MemAvailable`，缺失时使用可解释等价 | `GlobalMemoryStatusEx.ullAvailPhys`，不是 total-free |
| cgroup | 从 mountinfo 定位 v2/v1；无正上限不参与余量约束 | N/A，返回 `none + reason` |
| 进程身份 | ppid + `/proc/<pid>/stat` starttime | Toolhelp ppid/PID + `GetProcessTimes` |
| 终止 owned 树 | 叶子→根 SIGTERM，5 秒后 SIGKILL | Koffi 先 TERM，宽限后 `TerminateProcess` |
| 路径安全 | lstat/realpath/symlink | lstat/realpath，并检查 `GetFileAttributesW(REPARSE_POINT)` |

Koffi DLL/函数失败必须返回 `unavailable + reason`，不能猜 0。Windows ARM64 只有真实硬件验收后才能声明支持。

## 7. 诊断与证据

每次运行创建独立 run-id，证据根为 `artifacts/v0.1.14/`。至少保存原子写入的 `summary.json`、`raw/<phase>-attempt-N.log`、必要的 `residual-processes.json` 和测试清单/结果。日志脱敏 Authorization、Cookie、token、API key，但保留真实退出码。

退出码：`0` success，`2` usage，`3` resource blocked/aborted，`4` child failed，`5` internal。`passed_after_oom_retry` 不得伪装首次通过。每次正式版本发布必须保留同 SHA 的资源记录、平台结果、D/C/M verdict、工作流 run URL 和资产溯源；`.resource-bench/` 只是临时基线目录，不提交。

## 8. 缓存性能方法

先在同机、同负载、隔离 SQLite 和本地 HTTP Stub 上取得基线，再比较候选；不调用付费厂商。记录原始样本，延迟 P50/P95 用 nearest-rank；运行诊断直方图只标 `histogram_nearest_bucket`，不得把桶估值当精确值。

- 命中写放大：每 1000 次命中 mutating SQL 数（commit 另计）降低 ≥20%，命中 P95 不恶化 >5%，RSS 不增 >5%，LRU/TTL/统计不变；未达标保留原实现并报告 `PASS_NO_OPTIMIZATION`。
- 容量：条数与 UTF-8 逻辑 bytes 双上限、LRU、TTL、超大拒绝与真实并发写；DB/WAL 文件大小和 OS page cache 分开，不把逻辑 bytes 当磁盘占用。
- 击穿：100 并发冷启动、固定 fixture、唯一临时 DB，比较真实 Stub upstream 次数；未复现不实现 Singleflight。
- 存储：RSS、DB、WAL、OS cache、维护耗时分开报告；不做每次 `VACUUM`。

## 9. 服务端 RuntimeMonitor

`GET /api/admin/resources` 是管理员 session 专用的只读快照，仪表盘只提供手动刷新，不引入轮询。

- 认证：任何 `Authorization` header 在 Token 验证前返回 403；无 cookie/无效/过期/畸形 expiry session 返回 401。session lookup 使用 `{readOnly:true}`，不更新 `lastSeenAt`，过期或畸形 expiry 分支不 DELETE。
- 进程：RSS 来自 Node 进程内存口径；heapUsed/heapTotal/external/arrayBuffers 来自 V8；uptime 来自 `process.uptime()`，失败时为 null + unavailable。字段来源写入 `process.sources`；非有限/负字节值不进入响应。
- 活动：`activeSearches = SearchService.controllers.size`；`activeProbes = HealthService.inFlight.size`；`queue.total = providerKey + health + singleflightFollowers`。Singleflight 只计显式 follower，不计物理执行 leader。
- Provider Key 队列：KeyScheduler 在进入/离开等待时发送 ±1，ProviderService 聚合为 O(1) `queueDepth`；scheduler reload 保留旧实例，因此旧 waiter 完成仍能精确递减。
- Health 队列：每次 checkMany 增加本地待处理数量，worker shift 时减 1；`Promise.allSettled` 等待全部 worker 结束后只扣一次剩余 `queue.length`，再重抛首个 rejection。并发 checkMany 的队列数相加，取消/异常最终归零。
- 缓存：`cache.totals()` 只读 `search_cache_state` 主键；缺失、损坏时间戳、非法数值或读取异常返回 null+reason，不修复、不写 DB。RuntimeMonitor 严禁调用 `cache.stats()` 或全表聚合。
- 磁盘：DB/WAL 分别 `statSync`，口径是 `whole_sqlite_database`，不是 cache-only。ENOENT、权限、内存 DB、其他 stat 错误逐字段返回 null 与枚举 reason，不返回路径或原始错误消息。
- 生命周期：RuntimeMonitor 不持 timer/listener，不写 task/audit/health/budget/cache metrics，不触发 kill/restart/prune/并发或 Swap 修改。
- benchmark 安全：仅 clean HEAD 可运行，dirty worktree 直接 internal/worktree_dirty；git 预检失败写 terminal internal/source_preflight_failed，不留下 running artifact；真实运行失败继承预检的 cleanWorktree。SIGINT/SIGTERM 通过 AbortController 中断 HTTP/IPC，HTTP 固定 30 秒超时；晚到信号在 snapshot/budget、报告与 artifact finalization 前再次检查。终态优先级为 artifact failure/internal(5) > cleanup/residual failure/child_failed(4) > abort/resource_blocked(3) > 阈值结果；abort 与 cleanup failure 共存时保留 abortReason，但不把 4 降成 3。warmup 前后与测量前后都记录 total_changes，warmup delta 必须为 0。采样不重叠；child 使用 OwnedProcessTree 身份绑定清理，stderr 有界脱敏，残留写完整 pid/ppid/startTime。辅助证据先写，benchmark JSON 后写，summary 最后 finish；任一步失败 best-effort 重写 internal 并重试 finish。DB、临时目录或 artifact 收尾失败进入 terminal failure；cgroup OOM 计数与 owned RSS peak 未知时记录 null+unavailable，不伪造 0。

## 10. 内存术语停止线

`NODE_OPTIONS=--max-old-space-size` 只限制 V8 old space，**不等于 RSS**，也不限制 external、ArrayBuffer、native 插件、浏览器或进程树。不得通过随意加大该值掩盖资源不足；设置必须来自冻结预算并在证据中记录。总内存、可用内存、Swap、Node heap、OS RSS、DB/WAL 与 page cache 是不同口径，不能相互替代或重复扣除。
