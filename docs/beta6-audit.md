# v0.1.4-beta.6 稳定性审计报告

审查基线：`v0.1.4-beta.5`（main `dc92277`）｜ 修复分支：`fix/beta6-stability`

每一条都是先在真实运行的 API / 启动器上复现，再改代码。
没有复现证据的猜测不列为 Bug。

## 确认并修复的缺陷

### A1（高）Deep Search 在所有子查询失败时返回 `completed`

**根因**：`runDeep()` 用 `outcomes.filter(item => item !== null)` 判断“有效响应”，
而 `executeSearch()` 在全部 Provider 失败时**不抛异常**，只返回 `status:"failed"`。
于是 `valid` 非空，最终 `status` 由 `valid.some(partial)` 决定 → `completed`，
`results` 为空，任务表也写 `completed`。

**复现**（`mode=deep` + 单个始终 503 的 Provider）：
```
HTTP: 200 status: completed results: 0 errors: 1
task.status: completed
```
修复后：
```
task.status: failed
RAW_BODY: {"status":"failed","errors":[{"providerName":"Deep search","code":"server_error",
          "message":"Query \"audit deep\" failed: Mock HTTP 503","query":"audit deep"}],"providers":[]}
```

**修复**：按子查询索引（不是按查询文本，避免重复改写互相覆盖）区分成功/失败；
全失败返回 `status:"failed"` 并把每个查询的错误（含 `query` 字段）放进 `errors`/`failedSources`；
部分失败一律 `partial`；同时对失败响应跳过摘要模型调用，避免在真正的故障上再叠一条误导性错误。

**影响范围**：所有 `mode=deep` 请求；已发布版本会把故障掩盖成“成功但没结果”。
**数据影响**：历史 `search_tasks` 中 deep 记录的 `completed` 可能是假成功，不做回填（无法区分），
但新记录正确。

### A2（高）缓存键遗漏关键输入

**根因**：`cacheKey` 只包含 query/mode/providers id/limit/language/freshness/模型 id 与开关，
遗漏 `includeRaw`、`perProviderLimit`、`timeoutMs`、`capability`，以及
**Provider 的配置本身**（endpoint、vendor options、平台搜索参数）。

**复现**（旧代码）：
```
rich:  cached? undefined (includeRaw=true 首次写入)
plain: cached? true      (includeRaw=false 命中同一条缓存 → 语义不符)
perProviderLimit reuse: true
```
修复后：两者均为 `undefined`，而“真正相同的请求”仍然 `cached: true`。

**修复**：把上述字段加入键，并为每个 Provider 计算 `providerFingerprint(id|type|baseUrl|maxResults|language|freshness|config|search)`。
配置一变键就变，旧条目自然失效，不需要整体关闭缓存。

**数据影响**：无。旧缓存是内存态，重启即消失。

### A3（高）缓存命中把 partial 记成 completed

**根因**：命中分支硬编码 `status: "completed"` 写入 `search_tasks`。

**修复**：写入 `cached.status`；同时取消的请求不再写入缓存（`!cancelled` 才缓存）。
回归测试：两个 Provider（一好一坏）→ 首次 `partial`，二次命中仍 `partial`，任务行 `partial`。

### A4（高）显式 Model ID 绕过 enabled 开关

**根因**：`chatModel(id)` / `embeddingModel(id)` / `rerankModel(id)` 用 `get(id)`，不检查 `enabled`。
管理员禁用的模型仍能被普通搜索请求按 id 调起来，产生真实费用。

**修复**：新增 `getEnabled(id, kind)`（不存在 → 404；类型不符 → 400；已禁用 → 400），
三个入口全部改用它；搜索入口在消耗 Provider 额度**之前**校验显式 id。
管理员测试接口 `/api/admin/models/:id/test` 仍用 `get()`，保留“先试后启”的能力。

**影响范围**：任何带 `chatModelId/embeddingModelId/rerankModelId` 的请求。

### A5（严重）跨 Token 任务越权读取与取消

**根因**：`GET /api/search/tasks/:id` 里写着 `void actor;` —— 鉴权了但没用；
`cancel(id)` 同样不校验归属。

**复现**：
```
A search: 200 task: task_...
B reads A's task: 200 query leaked: alice private query
B cancels A's task: 200
```
修复后：
```
B reads A's task: 404 query leaked: (none)
B cancels A's task: 200 {"ok":false}
```
返回 404 而不是 403：任务是否存在本身也不该泄露。

**修复**：`getTask` 返回 `actor`；路由比对 `actorLabel(actor)`，不匹配按 not_found 处理，
且响应中剥离 `actor` 字段；`cancel(id, actor)` 同样校验。

**影响范围**：多 Token 部署；单管理员部署下仍属于纵深防御缺陷。

### A6（中）启动器：锁、身份与停止可靠性

| 缺陷 | 证据 | 修复 |
|---|---|---|
| 锁非原子，两次双击可能都通过检查 | 旧代码 `readFileSync` 后 `writeFileSync` | `openSync(LOCK_PATH,"wx")`（O_EXCL），输者读锁并报告已在运行 |
| 只靠 PID 判活，PID 复用会误判 | 旧 `readLock` 仅有 `kill(pid,0)` | 加 `/proc/<pid>/stat` 启动时间比对；无 /proc 时退化为健康探测 |
| 陈旧锁让程序永久无法启动 | 测试：写一个死 pid 的锁 → 旧行为报“另一个启动器正在初始化” | `reclaimStaleLock()` 先 `rename`（原子）再删除 |
| `--stop` 超时仍打印“已停止”并删锁 | 旧代码 15s 后无条件 `unlinkSync` | 只有确认 pid 消失且健康探测失败才算成功，否则退出码 8 并保留锁 |
| 可能给无关进程发信号 | 旧代码直接 `kill(lock.pid)` | 先校验身份（pid 存活 + start time + 健康探测），不匹配则只清锁不发信号 |
| 健康检查超时后子进程遗留 | 旧代码 `process.exit(5)` 前不杀子进程 | `terminate()`：SIGTERM → 10s → SIGKILL，并释放锁 |
| 端口占用/配置非法仍写入配置 | 旧代码先 `saveConfig` 再检查端口 | 校验端口与监听地址 → 试锁 → 端口探测 → 才写配置 |
| 退出码被覆盖 | 子进程 exit 处理器 `process.exit(0)` 抢先 | `stopping` 标志，主动停止时不覆盖自身退出码 |

验证：`packaging/launcher/lifecycle-test.mjs` 12 项断言全过（Windows 实测），
已接入 CI 的 `Launcher lifecycle (Windows)` job。

### A7（中）仪表盘成功率把“用户取消”算成失败

**根因**：`successRate = (completed + partial) / total`，`cancelled` 落在分母里，
且 `partial` 被算作成功。

**修复**：成功率只统计**已结束且非取消**的运行（`completed / (completed+partial+failed)`），
并把 `partial / failed / cancelled` 单独输出到 `totals`，仪表盘提示行直接展示三个计数。
这是后端语义修正，不是改前端文案。

## 审计中检查但未发现缺陷的部分

| 项 | 结论 |
|---|---|
| 多 Key 调度与取消竞态 | `lease` 幂等释放，取消路径 `release({cancelled:true})` 不会误计失败（`fanout.ts`） |
| SQLite 备份 | 已用 Online Backup API + `integrity_check` + schema 版本头，非 checkpoint+readFile |
| 密钥泄露 | 列表/导出接口不含明文；`secret-scan` 覆盖工作树与历史 |
| MCP 连接 | 连续 30 次 tools/call 与 5 次中途 abort 后服务仍健康，无遗留任务 |
| 缓存跨用户隔离 | 搜索结果本身不含调用者身份；任务归属已按 A5 收紧 |
| Provider 配置更新 | `providers.reload()` 重建调度；缓存通过指纹失效（A2） |
| 数据目录权限 | Linux 包以非 root 运行、数据目录独立；Windows 在 `%LOCALAPPDATA%` |

## 兼容性

- **数据库**：无 schema 变更，仅 `search_tasks.status` 的取值语义更准确。
- **配置**：`launcher.json`/`launcher-config.json` 未改格式；旧锁文件会被自动回收。
- **API**：`SearchErrorSummary` 只新增可选 `query`；`DashboardStats.totals` 只新增可选计数。
  响应形状向后兼容。
- **已发布用户数据**：不需要迁移；唯一“历史不准确”的是旧 deep 记录的 status，已在报告中标注。

## 黑盒验证：用已发布的 beta.5 安装包复现，再用修复后的包验证

不是只在源码运行环境里测：把 Release 里的 `windows-x64.zip` 解压、用 `SearchHub.exe` 起服务，
通过 REST 复现两条最严重的缺陷。

**beta.5（已发布产物）**
```
beta.5 package → HTTP 200 status=completed results=0
beta.5 package → bob reads alice's task: HTTP 200 leaked=YES
```
**修复后的包（同一条脚本、同一个 SQLite/launcher 布局）**
```
fixed package → HTTP 503 status=failed results=0
fixed package → bob reads alice's task: HTTP 404 leaked=no
```
脚本：`.data/audit/blackbox.mjs`（对照 `packaging/verify-package.mjs` 的完整生命周期验收）。

## Windows / Linux / Docker 验证

| 平台 | 方式 | 结果 |
|---|---|---|
| Windows x64 | 打包 → `verify-package.mjs` 全项通过；黑盒复测缺陷已消失 | 通过 |
| Windows 启动器 | `lifecycle-test.mjs` 12 项（含第二次双击、陈旧锁、无关 PID、健康超时、停止确认） | 通过，已接入 CI |
| Linux x64 / arm64 | CI `Release packages` 工作流在对应架构 runner 上跑同一套启动验收 | 由 CI 覆盖 |
| Docker | `Image, compose stack, MCP and 11-item acceptance`（24/24、Trivy 0/0） | 通过 |
