# v0.1.5-beta.2 交付执行状态

维护者要求：五阶段持续自主执行，不再分阶段询问。本文件记录每项的真实状态，
完成后立即更新。"已完成"必须有可复查证据，没做的写未做。

## 阶段一：版本与安装包不同步

| 检查 | 状态 | 证据 |
|---|---|---|
| 最新 main HEAD | ✅ `1456b44` | `gh api .../branches/main` |
| `v0.1.5-beta.1` tag 的 SHA | ✅ `c5f7a8c` | 早于 catalog 修复 |
| beta.1 是否含 MiniMax/Metaso 条目 | ❌ **不含** | `git show c5f7a8c:.../catalog.ts \| grep -c` = 0；main = 2 |
| 结论 | 需发布 `v0.1.5-beta.2` | tag 不含修复提交 |

## 阶段二：健康监控

| 项 | 状态 |
|---|---|
| 仪表盘实时健康 | ✅ `dashboard.tsx` HealthSummary |
| 最近检查/延迟/成功率/错误码 | ✅ 同卡片显示 lastCheckedAt / P50 / 成功率 / lastErrorCode |
| 七种状态区分 | ✅ healthy / degraded / unhealthy / unverified + cause（rate_limited / auth_invalid / quota_exceeded / network / timeout …） |
| MCP 只读健康工具 | ✅ `get_provider_health`（工具数 10→11） |
| 健康驱动的故障隔离 | ✅ `HealthService.blockedProviders()` 接入 `SearchService` |
| 周期探测（开关/间隔/并发） | ✅ `scheduledEnabled` / `intervalMinutes` / `concurrency`（上限 4） |
| 付费源默认不自动调用 | ✅ `paidProbesEnabled=false`，关闭时返回 400 而非降级 |
| 临时超时不永久禁用 | ✅ 只有 quota_exceeded / auth_invalid 会 park；超时仅冷却 |
| 管理后台不泄露 Key/内网地址 | ✅ `/api/mcp/health` 投影无 baseUrl、无 history、无 key；`/api/admin/health` 需 admin |
| Web→REST→MCP→调度器端到端测试 | ✅ `tests/integration/health-e2e.test.ts` 6 项 |

## 阶段三：更新与回滚

| 项 | 状态 |
|---|---|
| Windows 检查/下载/校验/备份 | ✅ `updater.ts`（stage，digest 来自发布元数据） |
| 独立 updater 进程 | ✅ `packaging/launcher/updater.mjs` |
| 更新后重启 + 健康检查 | ✅ 实测 16 项断言通过 |
| 健康失败自动回滚 | ✅ 退出码 3 = 已回滚且健康 |
| Linux systemd 更新流程 | ✅ 同一 CLI；systemd 场景由 `--stop`/`--service` 覆盖（未在真实 systemd 上跑） |
| Docker 只给提示不改镜像 | ✅ `/api/admin/update/apply-plan` 返回 pull/compose 步骤 |
| 不可逆迁移阻止不安全回滚 | ✅ `planRollback()`：schema 前移且无备份 → `blocked` |
| 防篡改/路径穿越/错误架构/降级 | ✅ 各有独立测试 |

## 阶段四：真实 Provider 验证

| 项 | 状态 |
|---|---|
| provider-live Environment 检查 | 已完成（见 docs/provider-live-deployment-status.md） |
| 无 Key 时标记 BLOCKED | 已完成（BLOCKED (no credential)） |
| 有 Key 后真实调用 | 阻塞：无凭证 |

## 阶段五：发布

| 项 | 状态 |
|---|---|
| CI / Docker / 安全扫描 | 待做 |
| 三平台安装包 | 待做 |
| Release 资产复测 | 待做 |
| 市场可见性实测 | 待做 |
| 升级不丢数据 | 待做 |
| Prerelease + GHCR | 待做 |
