# 更新机制生产级验收

本文件记录 v0.1.6-beta.1 之后的更新链路验收：跨版本升级、故障注入、systemd、
供应链审计与健康误判。**每一条都注明是在哪跑的和结果**，没跑的不写"通过"。

## 一、跨版本升级

| 路径 | 环境 | 状态 |
|---|---|---|
| `v0.1.4-beta.6` → 当前 | GitHub Actions（windows-latest / ubuntu-latest） | 由 `.github/workflows/upgrade.yml` 实测 |
| `v0.1.5-beta.1` → 当前 | 同上 | 同上 |
| 同版本重启 | 本机 + CI | **不计入升级**；只用于数据持久化 |

为什么必须在 CI 跑：本机下载发布资产会在 ~6–12 MB 处被代理截断（实测 11,673,605 /
49,356,298 字节），无法得到完整安装包。脚本会对每个资产做**大小比对**，
截断会直接报错而不是悄悄退化成同版本重启。

每条路径验证：管理员账号、Provider、API Key（升级后仍能解密）、搜索参数、
数据库、`master.key`（逐字节相同）、旧会话、REST、MCP（initialize + tools/list）。

## 二、更新中断故障注入

`packaging/launcher/updater-faults.mjs`，本机实测 **22 项断言全过**：

| 用例 | 注入方式 | 结果 |
|---|---|---|
| A 下载截断 | 声明长度 +4 KiB | exit 1，`size_mismatch`，程序与数据未变 |
| B 归档损坏 | 校验和正确但内容不是归档 | exit 4，未替换，无遗留服务 |
| C 安装失败 | app 目录不可写（Linux） / 程序仍可运行（Windows） | 旧程序或多或少先保住一个可运行状态 |
| D 停止冲突 | 端口被另一进程占用 | 数据未损，失败可见 |
| E 启动超时 | 新程序永不监听 | exit 3，回滚，旧程序恢复，单进程 |
| F 健康检查失败 | 新程序返回 503 | exit 3，回滚 |
| G 迁移不兼容 | 新程序把 `user_version` 改成 9 后启动失败 | exit 3，**数据库回到升级前字节**（schema=3） |
| H 磁盘满 | tmpfs 64k（仅 Linux，需 mount 权限） | 无权限时明确跳过并说明 |

**"不留两个进程同时写同一个库"**的保证方式：
launcher 单实例锁（O_EXCL）+ 更新器在替换前后都调用 `--stop` 并读取
`launcher.lock` 强制终止残留 pid（`hardStop`），再等待进程消失。

## 三、systemd（真实 systemd，不是同一 CLI 的模拟）

GitHub 的 ubuntu runner 本身没有运行 init（`systemctl` 会失败或变成假成功），
所以 `upgrade.yml` 的 `systemd` job 用 **特权容器 + systemd 作为 PID 1**
（`jrei/systemd-ubuntu:24.04`）跑真实流程：

1. 按 README 解压到 `/opt/search-hub`，创建 `search-hub` 系统用户
2. `systemctl daemon-reload && systemctl enable --now search-hub`
3. `systemctl is-active` + `/api/health`
4. `systemctl restart` → 健康检查
5. `systemctl stop` → **确认端口不再响应**（否则判定失败）
6. 用一个必然启动失败的包调用随包 `bin/update`，期望 **exit 3**（已回滚且健康）
7. `systemctl is-active` + `/api/health` 复查

## 四、供应链审计

`packaging/supply-chain-audit.mjs`（CI job `supply-chain`）：

| 检查 | 说明 |
|---|---|
| Tag → commit → main | 发布 tag 必须指向 main 上的提交 |
| `SHA256SUMS` vs 实际字节 | 逐个资产重算 |
| GitHub 自报 digest | 与本地重算比对——更新器信任的就是这个字段 |
| 资产名 vs 版本/架构 | 防止把 arm64 包喂给 x64 |
| 归档路径 | 拒绝绝对路径、`..`、Windows 盘符 |
| 文件权限 | launcher/updater 可执行；无 setuid/setgid |
| 信任锚 | **明确说明**：目前是 GitHub 账号 + TLS + API 的 digest；`gh release verify` 报告 **无 attestation**，所以没有签名的构建来源证明 |

审计发现的真实问题（已记录，未在本轮修复发布命名）：资产名用 `package.json` 的
`0.1.6`，而 tag 是 `v0.1.6-beta.1`，**单看文件名无法区分 beta 与正式版**。
已在 `build-package.mjs` 增加 `SEARCH_HUB_VERSION` 覆盖，release 工作流会传入 tag，
下一个版本起包名与 tag 一致。

## 五、健康监控误判审计

`tests/integration/health-e2e.test.ts`（8 项）：

| 场景 | 期望 | 结果 |
|---|---|---|
| 一次 429 | 不 park，仅冷却 | PASS |
| 一次超时 | 不 park | PASS |
| 账户级额度耗尽 | park，code=`quota_exceeded` | PASS |
| 403 无权限 | 不 park（换 Key/补权限可恢复） | PASS |
| 用户取消搜索 | 不影响源健康 | PASS（取消不写健康记录） |
| 全源被 park | 返回结构化 `failed`，不是空结果 | PASS |
| 被跳过的源 | **出现在 `failedSources` 与 `errors` 里** | PASS（本轮修复） |

修复的真实缺陷：健康门禁跳过某个源后，响应里**没有任何说明**，
调用方看到的只是"少了一个源"。现在 skipped 源会写进 `errors` 与 `failedSources`，
状态降为 `partial`。

另修：`updater` 的健康检查只看 HTTP 200。若端口上已有**旧版本进程**在响应，
更新器会误判成功。现在 `/api/health` 的 `version` 必须等于目标版本，否则按失败处理并回滚。
