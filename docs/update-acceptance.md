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

`packaging/launcher/updater-faults.mjs` — Windows 23 项、Linux 27 项（Linux 多 H），
本机与 CI 全过。

| 用例 | 注入方式 | 结果 |
|---|---|---|
| A 下载截断 | 声明长度 +4 KiB | exit 1，`size_mismatch`，程序与数据未变 |
| B 归档损坏 | 校验和正确但内容不是归档 | exit 4，未替换，无遗留服务 |
| C 安装失败 | Windows：在 `app` 内持打开句柄制造 EBUSY；Linux：安装根只读 | exit 3，旧版本仍以**自己的版本号**对外服务 |
| D 停止冲突 | 端口被另一进程占用 | 数据未损，失败可见 |
| E 启动超时 | 新程序永不监听 | exit 3，回滚，旧程序恢复，单进程 |
| F 健康检查失败 | 新程序返回 503 | exit 3，回滚 |
| G 迁移不兼容 | 新程序把 `user_version` 改成 9 后启动失败 | exit 3，**数据库回到升级前字节**（schema=3） |
| H 磁盘满 | `--data` 指向 512 KiB tmpfs，解压时 ENOSPC | 失败可见、该盘数据字节不变、仍有可运行程序、旧版本继续服务 |

两点必须说明：

- **H 早期版本是假测试**：它把程序拷到小文件系统，但更新器写入的是普通磁盘，
  断言必然通过。现在把 `--data` 直接指向 tmpfs，ENOSPC 发生在真实的解压路径上。
  环境若不允许 `mount`（包括 `sudo -n mount`），脚本打印 skip 并注明"不是通过"。
- **C 早期版本在 Windows 上也是假测试**：断言"要么成功、要么还有文件"在任何结果下
  都成立。现在用真实 EBUSY 触发失败，并断言旧版本必须恢复服务。

**"不留两个进程同时写同一个库"**的保证方式：
launcher 单实例锁（O_EXCL）+ 更新器在替换前后都调用 `--stop` 并读取
`launcher.lock` 强制终止残留 pid（`hardStop`），再等待进程消失。
systemd 环境下改由 `systemctl stop/start` 驱动，`hardStop` 主动跳过——
直接杀 unit 的子进程会被 `Restart=on-failure` 拉起并和新的启动竞争。

## 三、systemd（真实 systemd，不是同一 CLI 的模拟）

GitHub 的 ubuntu runner 本身没有运行 init（`systemctl` 会失败或变成假成功），
所以 `.github/workflows/systemd.yml` 用 **特权容器 + systemd 作为 PID 1**
（`jrei/systemd-ubuntu:24.04`，`--cgroupns=host`，挂载 `/sys/fs/cgroup`）跑真实流程：

1. 按 README 解压到 `/opt/search-hub`，创建 `search-hub` 系统用户
2. `systemctl daemon-reload && systemctl enable --now search-hub`
3. `systemctl is-active` + `/api/health`
4. `systemctl restart` → 健康检查
5. `systemctl stop` → **确认端口不再响应**（否则判定失败）
6. 用一个必然启动失败的包调用随包 `bin/update`，期望 **exit 3**（已回滚且健康）
7. `systemctl is-active` + `/api/health` 复查

这条链路刚开始是红的，红的原因是真问题，不是测试环境问题：

- 更新器无条件自起 launcher，和 unit 抢同一个端口/数据库 → 现在检测 unit 文件后
  改走 `systemctl`。
- 回滚成功了却报 exit 4。日志显示服务在 1 秒内就恢复了 —— 真正的原因是
  `launcher.json` 在 `app/` 之外，回滚只换回程序、清单里仍写着失败的新版本号，
  健康探测要求旧版本号、看到不匹配就判为"另一个构建在回答"。现在清单字节一起还原。

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

`tests/integration/health-e2e.test.ts`（9 项）：

| 场景 | 期望 | 结果 |
|---|---|---|
| 一次 429 | 不 park，仅冷却 | PASS |
| 一次超时 | 不 park | PASS |
| 账户级额度耗尽 | park，code=`quota_exceeded` | PASS |
| 403 无权限 | 不 park（换 Key/补权限可恢复） | PASS |
| 用户取消搜索 | 不 park、不写健康记录、**不计为失败调用** | PASS（本轮修复） |
| 全源被 park | 返回结构化 `failed`，不是空结果 | PASS |
| 被跳过的源 | **出现在 `failedSources` 与 `errors` 里** | PASS（本轮修复） |

本轮修掉的真实误判：

- **取消被记成源失败。** 搜索中途取消后，健康面板显示
  `searchCalls: 1, successRate: 0, consecutiveFailures: 1` —— 一个从未失败的源
  因为用户按了取消而变成"红"。根因在 `runProvider`：它只在错误是 `AbortError`
  或结构化 `cancelled` 时才认作取消，而常见路径是适配器用调用方 signal 等待、
  以 abort reason（普通 `Error("cancelled by user")`）reject，被分类成 `unknown`。
  现在以"调用方 signal 已 abort"为准；健康汇总与统计也不再把 `cancelled` 行当作
  源的流量证据（事件本身仍保留在 `search_events` 里）。
- **被健康门禁跳过的源在响应里没有任何说明**，调用方只看到"少了一个源"。
  现在 skipped 源会写进 `errors` 与 `failedSources`，状态降为 `partial`。
- **更新器健康检查只看 HTTP 200**：端口上若有旧版本进程应答会误判成功。
  现在 `/api/health` 的 `version` 必须等于目标版本，否则按失败处理并回滚。
