# Docker 部署验证（v0.1.2 / P0-3）

本文件记录三件事：本机为什么**跑不了**容器级验收（证据，不是结论）、
在任何有 Docker 的 Linux / CI 上**怎么一键跑**、以及每一项**应该看到什么**。

- 一键脚本：`scripts/docker-verify.sh`
- CI 工作流：`.github/workflows/docker.yml`
- 镜像定义：`Dockerfile` ｜ 编排：`compose.yaml`

## 0. 证据等级（读本文件前先看这张表）

三种证据的强度完全不同，**不要混用**：

| 等级 | 含义 | 本文件中的具体项 | 能证明什么 | **不能**证明什么 |
|---|---|---|---|---|
| **A. 实跑证据** | 真的执行了命令，有退出码/输出 | `docker version` / `docker info` / `docker build`（全部 exit 1）；`docker compose config --quiet`（exit 0）；`bash -n`；真实进程 + `curl /api/health` 实测 health 字段 | 引擎不可用这个**事实**；编排文件合法 | 镜像能构建、能运行 |
| **B. 静态/替身证据** | 读代码、语法检查、用 docker/curl 替身跑脚本逻辑 | Dockerfile 审查、`.dockerignore` 审查、workflow YAML 解析、`docker-verify.sh` 的 PASS/FAIL/SKIP 三分支 | 配置正确、脚本逻辑正确 | 镜像行为、真实容器状态 |
| **C. BLOCKED** | 根本没执行 | `docker build` 成功、`docker run`、重启/持久化/资源/崩溃恢复/漏洞扫描 的**实测** | — | 全部 |

**一句话**：`docker compose config --quiet` exit 0 **不等于**镜像能构建；`bash -n` 通过
**不等于**脚本能跑通真实容器。凡标注 BLOCKED 的项，本机**没有任何实测数据**。

---

## 1. 本机结论：BLOCKED（Docker Engine 不可用）

日期 2026-11-13 ｜ 主机 Windows（`windows/amd64`）｜ Docker CLI 29.9.2 / Compose v5.6.1

容器级 11 项验收**一项也没有执行**。不是"跑过但没记录"，是引擎起不来。
以下命令全部原样执行，退出码为实测值。

| # | 命令 | 退出码 | 关键输出（原文） |
|---|---|---|---|
| 1 | `docker version` | **1** | `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.` |
| 2 | `docker info` | **1** | 同上（Client 段正常，`Server:` 为空） |
| 3 | `docker ps` | **1** | 同上 |
| 4 | `docker build -t search-hub:v0.1.2 .` | **1** | `ERROR: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; ...` |
| 5 | `docker context ls` | 0 | `default → npipe:////./pipe/docker_engine`；`desktop-linux * → npipe:////./pipe/dockerDesktopLinuxEngine`（当前 context 是 `desktop-linux`） |
| 6 | `docker compose version` | 0 | `Docker Compose version v5.6.1`（客户端插件可用） |
| 7 | `docker compose config --quiet` | **0** | 无输出 = `compose.yaml` 语法与变量插值合法（此项可在无引擎时验证，已在本地通过） |

Windows 侧状态（PowerShell 5.1，**非管理员**）：

```
Get-Service com.docker.service
Name      : com.docker.service
Status    : Stopped
StartType : Manual

Start-Service com.docker.service
→ START_RESULT=FAILED
  ERROR=由于以下错误无法启动服务"Docker Desktop Service (com.docker.service)":
        无法打开计算机"."上的 com.docker.service 服务。
  CATEGORY=OpenError
```

```
Get-Process -Name "Docker Desktop","com.docker.backend","dockerd"  → none running
[System.IO.Directory]::GetFiles("\\.\pipe\") | ? { $_ -match "docker" } → no docker pipes
Test-Path "C:\Program Files\Docker\Docker\Docker Desktop.exe"      → True（已安装，未运行）
```

WSL 侧（Docker Desktop 的 Linux 引擎依赖它）：

```
wsl --status
→ PROGRAM BLOCKED BY SECURITY POLICY - The sandbox prevented a program on the
  configured Program Blacklist from starting: wsl.exe (C:\WINDOWS\system32\wsl.exe)
  This block cannot be approved or bypassed from the current command.
```

### 根因链

1. `desktop-linux` context 指向 `npipe:////./pipe/dockerDesktopLinuxEngine`，该命名管道**不存在**
   （本机 `\\.\pipe\` 下没有任何 docker 管道）。
2. 管道由 Docker Desktop 的 Linux 引擎创建，引擎依赖 WSL2。
3. `wsl.exe` 被宿主安全策略列入程序黑名单，**任何调用都会被拒绝**，且明确说明不可由当前会话绕过。
4. 兜底路径 `com.docker.service` 处于 `Stopped` + `Manual`，启动需要管理员权限
   （当前 `IsInRole(Administrator) = False`，报 `OpenError`）。

**因此：提升权限、改服务启动类型、改 WSL 配置都属于绕过系统安全策略，本次未执行、也不建议执行。**
容器级验收必须在其他机器（Linux 主机或 CI runner）完成，这正是第 2 节脚本与工作流存在的理由。

### 本机能做、且已做的部分

| 项目 | 结果 | 证据等级（§0） | 说明 |
|---|---|---|---|
| `docker compose config --quiet` | **PASS** | A 实跑 | 编排文件语法、变量插值、卷/健康检查定义合法。**仅此而已，不代表镜像可构建** |
| Dockerfile 静态审查 | **PASS**（附修正） | B 静态 | 见第 4 节，修掉了 3 个真实缺陷 |
| `.dockerignore` 审查 | **PASS**（附修正） | B 静态 | 补上 `*.db` 系列与 `.workbuddy` |
| CI 工作流审查 | **PASS**（附重构） | B 静态（YAML 解析） | 见第 5 节，拆出独立 `docker.yml` |
| 镜像构建、容器运行、重启、持久化、资源、崩溃恢复、漏洞扫描 | **BLOCKED** | C 未执行 | 全部需要引擎 |

---

## 2. 在有 Docker 的机器上怎么跑

### 2.1 Linux 主机（最快，一条命令）

前置：`docker`（含 daemon）、`docker compose` v2+、`bash`、`curl`、`openssl`（可选，缺省走 `/dev/urandom`）。
`trivy` 或 `docker scout` 可选（缺省时第 10 项记 SKIP 而非 PASS）。

```bash
git clone <repo> && cd <repo>
bash scripts/docker-verify.sh
echo "exit=$?"        # 0 = 全部执行项 PASS；非 0 = 有 FAIL
```

脚本行为：

* 使用**独立 compose project**（`shverify-<时间戳>`）和**独立命名卷**，不碰任何已有部署；
* 自动挑选空闲宿主端口（默认从 `18100` 起试）；
* 每次运行**现场生成**加密主密钥与管理员密码（`openssl rand`），不写仓库、不写 shell 历史；
* 结束时（含失败/中断）删除容器、网络、卷；**只删自己构建的镜像**；
* 输出 `PASS/FAIL/SKIP` 汇总表，并把日志与漏洞报告写到 `SEARCH_HUB_VERIFY_REPORT_DIR`（默认临时目录）。

常用参数：

```bash
# 复用 CI 已经构建好的镜像，跳过 build
SEARCH_HUB_VERIFY_SKIP_BUILD=1 SEARCH_HUB_VERIFY_IMAGE=search-hub:ci bash scripts/docker-verify.sh

# 出问题想进去看现场（保持容器与卷不被清理）
SEARCH_HUB_VERIFY_KEEP=1 bash scripts/docker-verify.sh

# 没有外网时：把真实联网那一项降级为 SKIP（CI 里禁止这么用）
SEARCH_HUB_VERIFY_ALLOW_SKIP_NETWORK=1 bash scripts/docker-verify.sh

# 漏洞门槛（默认 0/0，且默认忽略无修复版本的 CVE）
SEARCH_HUB_VERIFY_MAX_HIGH=0 SEARCH_HUB_VERIFY_MAX_CRITICAL=0 TRIVY_IGNORE_UNFIXED=1 \
  SEARCH_HUB_VERIFY_REQUIRE_SCAN=1 bash scripts/docker-verify.sh
```

### 2.2 GitHub Actions

`.github/workflows/docker.yml`，触发条件：PR / 推送到 `main`（相关路径变更时）、`workflow_dispatch`。

流水线：`quality job（checkout → pnpm install --frozen-lockfile → typecheck → lint → test → build）→ e2e job（Playwright Chromium）→ container job（checkout → setup-buildx（GHA 层缓存）→ build（load 到本地）→ docker compose config → 安装 trivy（v0.76.2，固定版本）→ scripts/docker-verify.sh（11 项）→ 上传报告 artifact → 失败时抓日志 → 清理容器/卷/镜像）`。container 通过 `needs: [quality, e2e]` 依赖前两者，代码不绿时不会构建镜像。

要点：

* `concurrency: docker-<workflow>-<ref>` + `cancel-in-progress`：同一 ref 不会并发跑同一份卷；
  每次运行的 project name 含 `run_id-run_attempt`，跨运行也不会撞；
* 凭据全部运行时生成（脚本内部 `openssl rand`），仓库里没有任何 token/密码；
* 第 10 项用 `SEARCH_HUB_VERIFY_REQUIRE_SCAN=1`：扫描器缺失**直接 FAIL**，不允许静默跳过；
* 报告以 artifact 形式保留 14 天（含 `PASS/FAIL` 结果表、完整日志、trivy 输出）。

### 2.3 手动复现某一项

```bash
export SEARCH_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)
SEARCH_HUB_CONTAINER_NAME=sh-manual SEARCH_HUB_HOST_PORT=18100 \
  docker compose -p sh-manual up -d --build
curl -sS http://127.0.0.1:18100/api/health
docker exec sh-manual cat /app/data/setup-token     # 初始化完成后该文件消失
docker exec sh-manual sh -c 'for p in /proc/[0-9]*; do grep -qa "apps/api/dist/server.mjs" "$p/cmdline" && kill -9 "${p#/proc/}"; done'  # 模拟进程崩溃
docker compose -p sh-manual down -v                 # 收尾
```

### 2.4 脚本本身是怎么验证的（在没有引擎的机器上）

脚本不能"写完就算"。本机无引擎，因此用两层手段保证它不是一段跑不通的代码：

1. **语法**：`bash -n scripts/docker-verify.sh` 通过。
2. **控制流**：用 `PATH` 注入的 `docker` / `curl` 替身（stub）跑通完整流程，
   覆盖 **PASS / FAIL / SKIP 三条分支**：
   - 全绿路径：`items=17 skipped=0 failed=0` → `RESULT: PASS`，退出码 0；
   - 注入故障（`/api/search` 返 503、扫描器缺失 + `REQUIRE_SCAN=1`）：
     `failed=3` → `RESULT: FAIL (3 item(s) failed)`，退出码 1；
   - 注入离线（`ALLOW_SKIP_NETWORK=1`、无扫描器）：`skipped=2`，SKIP 带原因打印。
   这一轮还抓到并修掉了一个真实缺陷：第 5 项里有一个同名变量覆盖了结果文件路径，
   导致汇总表从第 5 项起写进错误文件（见 §4.1 第 4 条）。
3. **替身不是验收集**：上面验证的是"脚本逻辑正确"，**不是**"镜像可用"。
   镜像与容器行为仍必须在有引擎的环境里由同一脚本判定。
4. **本地 `dist` 不是验收依据**：`apps/api/dist` 在 `.gitignore` 内，是开发态产物，
   可能与 `src` 有偏差（v0.1.2 就发生过 dist 比 src 旧 13 秒、health 字段与源码不一致）。
   判定运行时行为一律以 **Docker 镜像**（`COPY --from=build` 每次从 src 重编译）或
   **重新执行 `pnpm build` 后**的产物为准，不要拿工作区里遗留的 `dist` 当证据。

调试用参数：`SEARCH_HUB_VERIFY_LOAD_SEARCHES=<n>` 把第 8 项的 50 次压测调小
（只用于快速冒烟，正式验收用默认 50）。

---

## 3. 11 项验收：期望输出

| # | 项目 | 关键命令 | 期望 | 判定依据 |
|---|---|---|---|---|
| 0a | 工具链 | `docker info` | 退出 0 | daemon 可达 |
| 0b | 编排合法性 | `docker compose config --quiet` | 退出 0，无输出 | 变量插值、卷、健康检查定义合法 |
| 1 | 镜像构建 | `docker build -t search-hub:verify .` | 退出 0 | 记录 `id` 与 `size`（v0.1.1 无基线，见 §3.1） |
| 2a | compose 启动 | `compose up -d` → 轮询 `/api/health` | 90s 内 `200` | 容器 `running` 且 healthcheck `healthy` |
| 2b | 非 root | `docker exec <c> id -u` | `1001` | 与 Dockerfile `USER searchhub` 一致 |
| 3a | 前端产物 | `curl /` | `200`, `text/html`, 含 `<html` | 证明 `apps/web/dist` 进了镜像 |
| 3b | 健康接口 | `curl /api/health` | `200` + `"status":"ok"` | 含 `database.migrations`、`encryption.source` |
| 4a | 一次性 token | `cat /app/data/setup-token` | 长度 ≥16，`mode=600` | 无 `SEARCH_HUB_SETUP_TOKEN` 时自动生成 |
| 4b | 初始化 | `POST /api/setup {setupToken}` | `200` + `csrfToken` | 无 token → `403`（防抢占） |
| 4c | token 自清理 | 再次 `test -f /app/data/setup-token` | 文件已删除 | 初始化后不可重复使用 |
| 5a | 建源 | `POST /api/admin/providers {type:"hackernews"}` | `200` + `provider.id` | 免密钥源，用于真实联网 |
| 5b | 真实搜索 | `POST /api/search`（`hn-live`，`skipCache`） | `200`，`status=completed\|partial`，`results ≥1` | 每个结果带 `https://` 真实 URL；失败重试 3 次 |
| 5c | Key 加密与掩码 | `POST /api/admin/providers/{id}/keys` | `200` + `maskedKey` | 响应不含明文 Key；掩码为首 4+末 4 |
| 6 | 重启一致性 | `compose restart` → 对比 providers / dashboard | `hn-live` 计数不变、`searches` 不变、`session=200` | 配置在 SQLite，会话在 SQLite，均应存活 |
| 7 | 持久化 | `compose down`（不删卷）→ `up` | 卷存在、providers 与 searches 不变、`initialized=true` | 命名卷 `search-hub-data` 生效 |
| 8 | 资源 | `docker stats --no-stream` 空闲 vs 50 次搜索后 | 50/50 成功 | 记录 `cpu% \| mem \| mem%`（基线见 §3.1） |
| 9 | 崩溃恢复 | 在容器内 kill 掉 `server.mjs` 进程（模拟崩溃，而不是 `docker kill` 的显式停止）→ 轮询 health | 自动拉起，`RestartCount` 递增，health `200` | 再调 `POST /api/admin/maintenance/checkpoint`（`wal_checkpoint(TRUNCATE)`）须 `200`，providers/searches 不丢。`docker kill` 属于显式停止，`unless-stopped` 按设计不会拉起，不能用它验崩溃恢复 |
| 10 | 漏洞扫描 | `trivy image --severity HIGH,CRITICAL` | `CRITICAL=0`、`HIGH=0`（可配置） | 缺失扫描器且 `REQUIRE_SCAN=1` → FAIL |
| 11 | MCP Streamable HTTP | `POST /mcp`：initialize → tools/list → tools/call | tools ≥9；search_web 返回真实 URL + provider 归因 | REST 同 query 必须包含 MCP 首条 URL；无效 token 401/403 |

补充说明：

* 第 5、8 两项用**两个不同源**：`hn-live`（真实联网，只跑 1 次×3 次重试）与
  `mock-load`（本地确定性源，跑 50 次）。刻意不让 50 次压测打到厂商 API——
  既避免被限流，也让第 8 项在无外网时仍能测资源。
* 第 9 项用 `checkpoint` 接口而不是直接读文件，是因为它能证明**数据库被重新打开且可写**，
  比"文件存在"强。`SIGKILL` 后 SQLite 走 WAL 恢复，`integrity_check` 由该接口的
  `wal_checkpoint(TRUNCATE)` 间接覆盖。
* `SKIP` 永远打印原因，且**不计为通过**；`RESULT: PASS` 会额外注明"with N skipped"。

### 3.1 资源基线

本机 BLOCKED，**没有任何实测数字**，不做估算冒充测量。首次在 CI 跑通后，
把工作流 artifact 里的 `docker stats` 两行（idle / 50 次搜索后）填到这里：

| 场景 | CPU% | MEM USAGE / LIMIT | MEM% |
|---|---|---|---|
| 容器空闲（初始化 + 1 次搜索后） | 待测 | 待测 | 待测 |
| 50 次搜索后（mock 源，5ms 延迟） | 待测 | 待测 | 待测 |

`compose.yaml` 已声明 `deploy.resources.limits.memory: 1g`；2C2G 主机上
SQLite + 单进程 Node 的合理区间应在数百 MB 量级。若实测触顶或被 OOM kill，
先调 `--max-old-space-size` 与该项 limit，而不是直接加机器。

---

## 4. 静态审查：镜像与编排

### 4.1 已修正的真实缺陷

| # | 问题 | 影响 | 修正 |
|---|---|---|---|
| 1 | `prod-deps` 阶段基于 `deps`（含全部 devDependencies）再跑 `pnpm install --prod`，依赖 pnpm 的 prune 语义 | 一旦 prune 行为变化，`vite`/`esbuild`/`typescript` 可能被带进运行时镜像（体积与实际攻击面） | `prod-deps` 改为从 `base` **全新安装**，只拷 `package.json`，不继承 `deps` 的 `node_modules` |
| 2 | 运行时层用 `RUN chown -R searchhub:searchhub /app/apps /app/packages` | `chown -R` 会把所有被改属主的文件**复制进新层**，镜像体积接近翻倍 | 所有 `COPY` 改为 `COPY --chown=searchhub:searchhub`，只对 `/app/data` 做一次 `chown` |
| 3 | `corepack` 无 TTY 时可能因下载 pnpm 交互提示卡住 | 构建偶发挂起 | `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0` |
| 4 | `scripts/docker-verify.sh` 第 5 项用 `RESULTS=` 存搜索结果数，与结果汇总文件变量 `$RESULTS` 同名 | 汇总表从第 5 项起被写进名为 `1`（或结果数）的文件，真正的 `.results` 文件只剩前 10 行，`SUMMARY` 严重重复 | 改名为 `HIT_COUNT`，结果文件变量改为 `RESULTS_FILE`；用替身跑通后才发现 |

同时补强：

* 基础镜像改为 `ARG NODE_IMAGE=node:22-bookworm-slim`，可按 digest 固定（可复现构建）；
* 显式设置 `SEARCH_HUB_STATIC_DIR=/app/apps/web/dist`，不再依赖 `REPO_ROOT` 推断；
* `.dockerignore` 增加 `*.db` / `*.db-wal` / `*.db-shm` / `*.db-journal` 与 `.workbuddy`
  —— 否则本地 `data/` 之外的 `.db` 备份文件、以及可能含 token 的 agent 工作区会进入构建上下文。

### 4.2 已核对为正确的项

| 检查点 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile`（deps 与 prod-deps 两处） | 有，`--frozen-lockfile` 均存在 |
| `packages/skills` 是否进镜像 | 有（`COPY --from=build /app/packages/skills`），`/api/admin/skills` 从 `REPO_ROOT/packages/skills` 读取 |
| migrations | 有（`/app/apps/api/migrations`），并设 `SEARCH_HUB_MIGRATIONS_DIR` 指向它 |
| web dist | 有（`/app/apps/web/dist`），并设 `SEARCH_HUB_STATIC_DIR` |
| stdio dist | 有（`/app/packages/mcp/dist/stdio.mjs`） |
| 非 root | 有，`uid/gid 1001` + `USER searchhub` |
| healthcheck | 有，`fetch /api/health`，`start-period=20s retries=3`；`compose.yaml` 同构 |
| 优雅停机 | 有，`SIGTERM → app.close() → process.exit(0)`；compose 已设 `init:true` + `stop_grace_period: 30s` |
| `better-sqlite3` 原生模块 | `13.1.1` 自带 `prebuilds/linux-x64.node`，`node:22-bookworm-slim`（glibc）可直接加载，无需编译工具链 |

### 4.3 编排加固（已加，且与 SQLite 兼容）

| 项 | 状态 | 说明 |
|---|---|---|
| `cap_drop: [ALL]` | **已启用** | 进程只需绑定 >1024 端口、写 `/app/data` 卷，不需要任何 capability |
| `security_opt: no-new-privileges:true` | **已启用** | 阻断 setuid 提权路径 |
| `init: true` | **已启用** | 转发 SIGTERM、回收孤儿进程 |
| `stop_grace_period: 30s` | **已启用** | 覆盖 SQLite 收尾与在途请求 |
| `logging: json-file, max-size 10m × 3` | **已启用** | 防止日志写满磁盘 |
| `SEARCH_HUB_PROXY` / `_NO_PROXY` / `_PROXY_TRUST` 透传 | **已启用** | 见 §4.5：不加这三行，`.env` 里的代理配置永远进不到容器 |
| `read_only: true` + `tmpfs: /tmp` | **未启用，列为建议** | 理论上可行（写入点只有 `/app/data`），但需要实测确认 `better-sqlite3` 在只读根文件系统下不写 `/tmp`。**本机无引擎，无法验证，所以不做**。验证方法见下 |

启用只读根文件系统前的验证步骤（在有 Docker 的机器上）：

```bash
# 1) 加 overlay 试跑
cat > /tmp/ro.yaml <<'YAML'
services:
  search-hub:
    read_only: true
    tmpfs:
      - /tmp:size=64m
YAML
SEARCH_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  docker compose -p sh-ro -f compose.yaml -f /tmp/ro.yaml up -d --build
# 2) 初始化 + 真实搜索 + 重启，全部通过后再写进 compose.yaml
bash scripts/docker-verify.sh    # 以 KEEP=1 跑，便于观察
```

### 4.4 仍未处理（保持诚实）

* 镜像未用 digest 固定（默认 tag `node:22-bookworm-slim`）；出口网受限时建议改为 digest。
* 内存上限同时写了 `mem_limit` 与 `deploy.resources.limits.memory`（同值 `1g`，可用
  `SEARCH_HUB_MEM_LIMIT` 覆盖）：`deploy` 段在不同实现下是否被非 Swarm 的
  `docker compose up` 采用并不一致，`mem_limit` 是单机场景下更稳的那个键。
  两者同值是 Compose 规范要求的写法，`docker compose config` 已验证合法。
  **注意这是"声明了上限"，不是"实测了上限"**——是否真的生效需在有引擎的机器上
  用 `docker inspect -f '{{.HostConfig.Memory}}'` 确认（第 8 项会顺带记录 `mem%`）。
* 镜像无 `HEALTHCHECK` 之外的启动自检（如迁移失败快速退出）——已有 `process.exitCode = 1` 路径，够用。

### 4.5 代理配置的透传（与 P0-1 的接口对齐）

后端在 P0-1 加了出网代理（`SEARCH_HUB_PROXY` / `_NO_PROXY` / `_PROXY_TRUST`）。**只写进
`.env` 是没用的**：compose 的 `environment:` 是白名单，没有显式列出的变量不会进入容器。
本次已补上这三行（`compose.yaml`）：

```yaml
SEARCH_HUB_PROXY: ${SEARCH_HUB_PROXY:-}
SEARCH_HUB_NO_PROXY: ${SEARCH_HUB_NO_PROXY:-}
SEARCH_HUB_PROXY_TRUST: ${SEARCH_HUB_PROXY_TRUST:-}
```

验证过三件事（不依赖 Docker，纯配置层）：

| 场景 | 结果 |
|---|---|
| 三个变量都为空 | `resolveOutboundProxy` 返回 `{"enabled":false,"trust":"untrusted","trustDeclared":false,"source":"none"}` → 直连，**不报错** |
| 只设 `SEARCH_HUB_PROXY`、trust 为空 | `enabled:true, trust:"untrusted", trustDeclared:false`；`/api/health` 的 `outbound.proxyTrustDeclared=false` 即"边界未声明"的信号（完整 warning 文本在 admin 端点）→ 可用但边界未声明 |
| trust 设成非法值（如 `bogus`） | **抛错**：`Invalid outbound proxy trust level "bogus". Supported values: untrusted, trusted-networks (aliases: application-only = untrusted, egress-enforced = trusted-networks)` → 刻意 fail-closed，容器会一直 unhealthy |

三条对验证脚本的影响：

1. 脚本默认把这三个变量**钉成空**（`SEARCH_HUB_VERIFY_PROXY*` 才显式开启），
   避免验证结果被调用方的 shell 环境影响；
2. 代理模式下所有请求（含明文 HTTP）都走 `CONNECT` 隧道，代理必须放通到目标端口，
   不能只放 443——否则第 5 项会挂在代理 `502/407` 而不是 provider 错误；
3. 两个 outbound 端点的字段**不一样**，断言时不要混淆：

| 端点 | 鉴权 | `outbound` 字段 |
|---|---|---|
| `GET /api/health` | 匿名 | **只有三元组**：`mode`、`proxyTrust`、`proxyTrustDeclared` |
| `GET /api/admin/outbound` | admin 只读 | `describeOutboundPolicy()` 全量：`mode`、`proxyTrust`、`proxyTrustDeclared`、脱敏 `proxyHost`（`scheme://host:port`，无 userinfo）、`proxyHasCredentials`、`noProxyEntries` + `noProxy[]`、`privateHostAllowlistEntries`、`privateHostAllowlistHonored`、`allowHttp`、`maxRedirects`、`residualRisk`、`appEnforced[]`、`proxyMustEnforce[]`、`warnings[]` |

   匿名端点刻意粗粒度：proxy endpoint、NO_PROXY 条目和残余风险文本若匿名可达，等于把
   egress 拓扑（代理 `host:port`）泄漏给任何未鉴权的调用者，因此它们只在 admin 端点。
   所以"代理确实生效"的完整断言必须用 admin 端点；健康检查只断言 `mode`。
   脚本第 3 项只读取 `outbound.mode` / `proxyTrust` / `proxyTrustDeclared`，与该设计一致。

---

## 5. CI 结构调整

原 `ci.yml` 的 `build` job 里 `pnpm install --frozen-lockfile --prod`（"Production-only install and boot" 这一步）
会把 workspace 的 `node_modules` 裁成生产依赖，**之后**才 `docker build`。
Docker 上下文虽然靠 `.dockerignore` 排除了 `node_modules`，结论上不会坏，
但这让"构建失败"的归因变模糊（宿主树污染 vs 镜像问题），且与 `.dockerignore`
的排除规则形成隐性耦合。

处理方式：**拆成独立工作流**，职责单一。

| 文件 | 职责 |
|---|---|
| `.github/workflows/ci.yml` | lint / typecheck / vitest / 迁移冒烟 / web+server 产物 / 生产安装启动 / Playwright E2E / `pnpm audit` |
| `.github/workflows/docker.yml` | quality job（install/typecheck/lint/test/build）+ 镜像构建（层缓存）/ compose 校验 / 11 项容器验收 / trivy 门禁 / 清理 |

两处不重复：`ci.yml` 不再构建镜像，`docker.yml` 不再跑单元测试。

---

## 6. 常见失败与排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `0. toolchain` FAIL，`npipe ... cannot find the file` | 本机没有可用 Docker 引擎（即本文件的场景） | 换 Linux 主机或 CI |
| `2a` 超时，容器 `Exited (1)` | 迁移失败 / `apps/web/dist` 未生成 | `docker logs <c>`；检查 `pnpm build` |
| `3a` 返回 503 | 镜像里没有静态产物 | 确认 `COPY --from=build /app/apps/web/dist` |
| `4b` 返回 403 | 未读到 token，或 env 里设置了 `SEARCH_HUB_SETUP_TOKEN` | 脚本会清空该变量；手动跑时注意 shell 环境 |
| `5b` 失败且 `failedSources` 为 `timeout`/`network` | 出网被阻断 | 换网络；或本地用 `ALLOW_SKIP_NETWORK=1`（不得用于发布判定） |
| `5b` 失败，容器日志里是代理 `502`/`407` 而非 provider 错误 | 配了 `SEARCH_HUB_PROXY` 但代理拒绝该 `host:port` 的 CONNECT（明文 HTTP 也走 tunnel） | 放通 CONNECT 到目标端口，不要只放 443；或先设 `SEARCH_HUB_PROXY=""` 直连验证 |
| 容器反复重启，`docker logs` 里有 `Invalid outbound proxy` | 代理配置非法（`socks5://`、`pac+http://`、`file://`，或 trust 取非枚举值）——**刻意 fail-closed** | 改成 `http(s)://` 且 trust ∈ {`untrusted`,`trusted-networks`}；不要期待它退回直连 |
| `6`/`7` 数据不一致 | 卷被复用成旧数据，或 `SEARCH_HUB_DATA_DIR` 被覆盖 | 确认 `-v` 清理；确认 compose 里 `SEARCH_HUB_DATA_DIR=/app/data` |
| `9` 未自动拉起 | `restart` 策略被覆盖成 `no` | `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}'` 应为 `unless-stopped` |
| `10` 有 HIGH 且都是 unfixed | 基础镜像尚未发补丁 | 默认 `--ignore-unfixed` 不计入；若要强制清零，`TRIVY_IGNORE_UNFIXED=0` 会立刻暴露真实债务 |
| `docker compose` 报 app 名冲突 | 同一 project 名并发运行 | 脚本已用时间戳 project；手动跑请显式 `-p` |

---

## 7. 状态勾选表

| 验收项 | 状态 | 证据等级（§0） | 证据位置 |
|---|---|---|---|
| 本机诊断（命令 + 退出码 + 原文） | **DONE** | A 实跑 | §1 |
| 编排文件静态合法性 | **PASS** | A 实跑（`docker compose config --quiet` exit 0） | §1 表格中该命令所在行 |
| Dockerfile / `.dockerignore` 审查与修正 | **DONE** | B 静态 | §4.1 |
| 一键验证脚本 | **DONE** | B 静态 + 替身（`bash -n` exit 0；PASS/FAIL/SKIP 三分支跑通） | `scripts/docker-verify.sh`、§2.4 |
| CI 容器工作流 | **DONE** | B 静态（YAML 解析通过） | `.github/workflows/docker.yml` |
| 镜像构建成功 | **BLOCKED** | C 未执行 | 需在有 Docker 的 Linux/CI 上跑 |
| 11 项容器验收实测 | **BLOCKED** | C 未执行 | 需在有 Docker 的 Linux/CI 上执行 `bash scripts/docker-verify.sh` |
| 资源基线 | **BLOCKED** | C 未执行 | 首次 CI 通过后回填 §3.1 |
| 漏洞扫描 HIGH/CRITICAL 实测 | **BLOCKED** | C 未执行 | 同上，结果在 artifact `vulnerabilities-*.txt` |
