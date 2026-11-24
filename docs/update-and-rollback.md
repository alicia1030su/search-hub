# 程序更新与回滚

服务进程**不会**替换自己的文件。更新由独立进程 `packaging/launcher/updater.mjs` 完成，
原因有两个：Windows 上运行中的 `SearchHub.exe` / `node.exe` 被锁定；Linux 上服务归 systemd 管。

## v0.1.15 事务流程

```text
稳定版检查 → 流式下载/校验 → 解析服务配置 → 安全列出/解压 → 严格停服证明
→ readonly VACUUM INTO 一致快照 → 完整 dataDir 备份 → journal
→ 原子 app/ 交换 → 启动 → 精确版本健康检查
                                          ↓ 失败
                              停服证明 → app/ 回滚 → 整 dataDir 交换回滚
                              → 恢复 manifest → 启动旧版 → 精确版本健康检查
```

关键规则：

- 只提供稳定版；语义版本比较正确处理 `beta.2 < beta.10`，稳定版不会被 prerelease 覆盖。
- 资产名必须精确匹配 OS、架构和版本；下载按块写入并计算 SHA-256，不把整个包读入内存。
- `ServiceConfigResolver` 从显式参数、环境变量、systemd unit/EnvironmentFile/ExecStart、
  launcher 配置和平台默认值解析 `DATA_DIR` / `DB_PATH`。相对 `SEARCH_HUB_DB_PATH` 相对 dataDir。
- `systemctl stop`、launcher stop、PID/锁或端口检查无法证明服务已停止时，升级直接拒绝。
- 升级前数据库备份只使用 `node:sqlite` 的只读连接执行 `VACUUM INTO`，再执行
  `PRAGMA integrity_check`；禁止 checkpoint 后复制主库，也禁止把 `db + WAL + SHM` 原样复制当恢复点。
- 备份位于 dataDir 的同盘 sibling 工作目录，避免把 dataDir 复制到自身内部。
- 回滚交换整个 dataDir：`current → failed`，`pre-update backup → current`。
  失败版本的数据目录保留用于追溯，旧程序不会与新 schema/WAL 混用。
- `transaction.json` 记录每个破坏性阶段；下次更新发现未完成 journal 时先恢复旧程序和数据。
- Docker 内不自我替换；`/api/admin/update/apply-plan` 只返回镜像更新步骤和迁移不可逆提醒。

## 为什么校验和取自发布元数据

`updater.ts` 使用 GitHub release asset 的 `digest` 字段（服务端计算的 `sha256:`），
而不是随包下载的 `SHA256SUMS`。一个被篡改的发布可以自带一份匹配的假校验文件，
所以「同源校验」在威胁模型里等于没有校验。候选发布链还会在无 tag 阶段预先验证
资产、Provenance 和 GHCR digest；正式 tag 后只提升候选，不重新构建。

## 回滚语义

`planRollback()` 用于报告 schema 判断，但 v0.1.15 的健康失败回滚总会交换完整的
升级前 dataDir（只要有备份），即使 schema 未变。这样失败版本可能写下的 WAL、缓存或
配置不会污染旧版本。升级后写入的数据会丢失，这是明确且必要的安全取舍。

| 情况 | 报告策略 | 实际安全动作 |
|---|---|---|
| schema 未变 | `program_only` | 仍保留失败 dataDir，并恢复完整升级前 dataDir |
| schema 前移 + 有升级前备份 | `restore_backup` | 程序与数据库一起回到升级前 |
| schema 前移 + 无备份 | `blocked` | 拒绝只换程序的不安全回滚 |
| 读不到 schema 版本 + 有备份 | `restore_backup` | 使用一致快照，不猜 schema |
| 读不到 schema 版本 + 无备份 | `blocked` | 标记需要人工介入 |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 更新完成且目标版本健康 |
| 3 | 更新失败但已回滚且旧版本健康 |
| 4 | 更新失败且回滚未达到健康状态，需要人工介入 |
| 1 | 在停服/替换前拒绝，或恢复后仍失败 |

## v0.1.15 本机实测

| 范围 | 环境 | 状态 |
|---|---|---|
| `updater-test.mjs` 健康升级、坏包回滚、篡改/降级/架构拒绝、数据保留 | Windows 本机真实进程与真实 ZIP | PASS |
| `updater-faults.mjs` A–G 故障注入 | Windows 本机隔离临时目录 | PASS |
| H 磁盘满 | 需要 Linux 特权 tmpfs | NOT TESTED |
| systemd 自定义 unit/data/db 路径 | 需要真实 systemd 容器或主机 | NOT TESTED |
| Linux arm64 独立真机 | 需要 arm64 硬件 | NOT TESTED |

历史 v0.1.6 的详细验收记录见 `docs/update-acceptance.md` 与
`docs/update-acceptance-findings.md`；其中旧退出码和旧 `hardStop` 描述仅适用于历史版本。
