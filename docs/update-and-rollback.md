# 程序更新与回滚

服务进程**不会**替换自己的文件。更新由独立进程 `packaging/launcher/updater.mjs` 完成，
原因有两个：Windows 上运行中的 `SearchHub.exe` / `node.exe` 被锁定；Linux 上服务归 systemd 管。

## 流程

```
检查版本 → 下载 → 校验 SHA256 → 备份 → 停服 → 替换 app/ → 启动 → 健康检查
                                                        ↓ 失败
                                              回滚程序（必要时回滚数据库）→ 启动 → 健康检查
```

## 为什么校验和取自发布元数据

`updater.ts` 使用 GitHub release asset 的 `digest` 字段（服务端计算的 `sha256:`），
而不是随包下载的 `SHA256SUMS`。一个被篡改的发布可以自带一份匹配的假校验文件，
所以「同源校验」在威胁模型里等于没有校验。

## 回滚不是万能的

程序文件回滚 ≠ 数据库回滚。`planRollback()` 的三种结论：

| 情况 | 策略 | 说明 |
|---|---|---|
| schema 未变 | `program_only` | 只换回程序即可 |
| schema 前移 + 有升级前备份 | `restore_backup` | 程序与数据库一起回到升级前，**升级后写入的数据会丢失** |
| schema 前移 + 无备份 | `blocked` | 拒绝"只换程序"的不安全回滚，并明确告知 |
| 读不到 schema 版本 | 不安全 | 不猜，标记为不可安全回滚 |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 更新完成且健康 |
| 3 | 更新失败但已回滚且健康（旧版本在跑） |
| 4 | 更新失败且回滚也没起来 → 需要人工介入 |
| 1 | 在动任何文件之前就被拒绝（校验/降级/架构/路径穿越） |

## Docker

容器内不自我替换。`/api/admin/update/apply-plan` 只返回 `docker pull` + `docker compose up -d`
的可验证步骤，以及"回滚镜像不会回滚迁移"的提醒。不使用 `latest`。

## 实测

`node packaging/launcher/updater-test.mjs`（已接入 CI 的 Windows job）覆盖 16 项：
健康更新、坏包回滚、篡改拒绝、降级拒绝、架构拒绝，以及数据（数据库 + 主密钥）保留。
