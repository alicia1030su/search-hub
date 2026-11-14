# GitHub 远端验收执行方案（唯一版本）

日期：2026-11-14 ｜ 本地 HEAD：`9dec043`（准备提交；文档提交可能再前进，以 `git rev-parse --short HEAD` 为准） ｜ 目标：取得**真实外部验收证据**，不新增 Mock 计数

> 本文件是远端验收的唯一执行方案。除本文列出的动作外，本轮没有创建远端、没有 push、没有打 Tag、没有创建 Release。

---

## 0. 执行结果（2026-11-14）

本方案已执行，结果如下。

| 项 | 结果 |
|---|---|
| 仓库 | <https://github.com/alicia1030su/search-hub> |
| Owner | `alicia1030su`（当前登录的个人账号） |
| 可见性 / 默认分支 | Public / `main` |
| 首次推送 | 成功，保留 22 个提交的完整历史（非强推） |
| 本地 / 远端 HEAD | `44e8720` 一致（后续仅追加文档提交） |
| CI | run [43582011967](https://github.com/alicia1030su/search-hub/actions/runs/43582011967) — 4/4 success |
| Docker | run [43582011942](https://github.com/alicia1030su/search-hub/actions/runs/43582011942) — 3/3 success，容器验收 24/24 |
| 镜像 | `search-hub:ci`，506 MB，Trivy CRITICAL=0 HIGH=0 |
| 安全设置 | Secret Scanning、Push Protection、Dependabot alerts 已启用；`GITHUB_TOKEN` 默认只读；`main` 5 个必需检查 + 禁止强推/删除 |
| Tag / Release / 镜像推送 | **未执行**（未授权） |

失败与修复（均为验收脚本缺陷，不是产品缺陷）：

1. `ci.yml` 中两处字面 `/n` 破坏了 YAML → 修复后 CI 全绿。
2. Docker run 1：`docker kill` 属于显式停止，`unless-stopped` 按设计不拉起；改为容器内 SIGKILL server 进程。MCP `tools/call` 的 payload 在 `content[0].text` 内且斜杠转义，grep 改为 JSON 解析。
3. Docker run 2：Trivy 10 个 HIGH 全部来自基础镜像自带 npm/corepack 依赖树；运行时阶段移除 npm/corepack（运行时不安装包），阈值未放宽。

## 1. Git 仓库只读审计（结论：适合推送）

| 检查项 | 结果 |
|---|---|
| 提交数 | 19（完整线性历史） |
| 分支 | 仅 `master`（无远端跟踪） |
| 远端 | **无**（`git remote -v` 为空） |
| Tag | **无** |
| Stash | 无 |
| 作者身份 | `Search Hub Dev <dev@searchhub.local>`（无个人邮箱） |
| 工作区 | 干净（本轮改动提交后） |
| `.git` 体积 | 2.8 MB |
| 最大对象 | `pnpm-lock.yaml` 89 KB（无大二进制、无数据库、无镜像） |
| 跟踪的敏感文件 | 仅 `.env.example`；无 `.env`、`*.db`、`master.key`、私钥 |
| 全历史密钥扫描 | `node scripts/secret-scan.mjs` **PASS，0 命中**（工作区 + 所有 ref） |
| 提交消息敏感信息 | 无 Key、无个人路径 |
| Git 配置 | 无 credential helper、无 token、无 insteadOf |

**判定：可以推送。** 历史中没有需要重写的内容，因此**不需要** `filter-repo`、`rebase` 或强推。

---

## 2. 工作流门禁审计

### 2.1 `workflow_dispatch`

| 工作流 | `workflow_dispatch` | 推送触发 | 说明 |
|---|---|---|---|
| `.github/workflows/ci.yml` | 有 | `push`（main/master）、`pull_request` | 质量、构建、E2E、安全 |
| `.github/workflows/docker.yml` | 有 | `push`（main/master，路径过滤）、`pull_request` | 独立容器验收 |
| `.github/workflows/provider-live.yml` | 有（唯一触发） | **无** | 真实 Key 专用，必须与无凭证验收隔离 |

### 2.2 失败阻断链

```text
ci.yml
  quality ──┬─> build
            ├─> e2e
            └─> security
  任一 job 失败 => workflow 失败

docker.yml
  quality ──> e2e ──> container
                        ├─ docker build（build-push-action，失败即 fail）
                        ├─ scripts/docker-verify.sh（任何 FAIL 退出非 0）
                        │    ├─ compose up / 初始化 / REST / MCP / Key 持久化
                        │    ├─ 重启 / 持久化 / 资源 / 崩溃恢复
                        │    └─ Trivy（HIGH/CRITICAL 超阈值即 FAIL）
                        └─ 上传 artifact / 诊断 / 清理（if: always，不掩盖失败）
```

- 全部工作流 **没有** `continue-on-error`。
- `quality`、`e2e` 是 `container` 的 `needs`；任一失败，容器 job **不会启动**，workflow 结论为 failure。
- Trivy 缺失且 `SEARCH_HUB_VERIFY_REQUIRE_SCAN=1` 时脚本记 **FAIL**，不是 SKIP。
- 诊断、上传、清理步骤使用 `if: always()` / `if: failure()`，只做收尾，不改变 job 结论。

### 2.3 本轮修正的 5 个真实 CI 问题

| # | 问题 | 后果 | 修正 |
|---|---|---|---|
| 1 | `push` 只监听 `main`，仓库当前分支是 `master` | 首次推送后工作流**根本不会触发** | 两个工作流都改为 `branches: [main, master]` |
| 2 | `docker.yml` 的 container job 没有 Node | `jget` 依赖宿主机 Node，Runner 版本不确定 | 该 job 增加 `actions/setup-node@v4`（22.22.2） |
| 3 | 容器验收没有 E2E 门禁 | 浏览器层坏了仍会构建镜像 | 新增 `e2e` job，`container` 改为 `needs: [quality, e2e]` |
| 4 | 无全历史密钥扫描 | 只扫工作区会漏掉历史提交 | `security` job `fetch-depth: 0` + `node scripts/secret-scan.mjs` |
| 5 | 产物外部依赖未在**生产依赖树**中验证 | 镜像构建成功、容器启动才崩 | `scripts/check-runtime-imports.mjs` 在 `pnpm install --prod` 之后运行 |

### 2.4 全新 Ubuntu Runner 依赖审计

| 依赖 | 来源 | 风险 | 处理 |
|---|---|---|---|
| Node 22.22.2 | `actions/setup-node` | 版本固定，Runner 自带版本不参与 | 已固定 |
| pnpm 12.18.0 | `pnpm/action-setup` | 与 `packageManager` 一致 | 已固定 |
| Docker Engine + Compose v2 | `ubuntu-latest` 预装 | 无 | 脚本已校验 daemon 与 compose |
| Buildx | `docker/setup-buildx-action@v3` | 无 | 已配置 |
| Trivy 0.76.2 | 官方 install.sh（固定版本） | 网络下载失败会 fail | 固定版本 + `set -euo pipefail` |
| Playwright Chromium | `playwright install --with-deps` | 首次下载较慢 | 独立 e2e job，超时 25 分钟 |
| `openssl` / `curl` / `sed` / `awk` / `tar` | Runner 预装 | 无 | 脚本不使用 jq/python |
| 宿主机 Node（jget） | 已装 22.22.2 | 无 | container job 也已安装 |

**不依赖开发机缓存**：`pnpm install --frozen-lockfile` 从 lockfile 解析；Docker 构建用 GHA 层缓存但可从零构建；没有任何步骤读取 `~/.data`、本地 `dist` 或 `.env`。

---

## 3. CI 凭据与产物泄漏审计

| 面 | 是否可能含密钥 | 证据 / 处理 |
|---|---|---|
| Workflow `secrets.*` | 仅 `provider-live.yml` 使用 | Docker/CI 工作流 **零** secret 引用 |
| 容器验收管理员密码 | 否 | 脚本运行时 `openssl rand` 生成，只用于 curl body，不打印 |
| 加密主密钥 | 否 | 运行时生成，仅通过 env 传入 compose，不打印 |
| 一次性 setup token | **本轮修复** | 之前会打印到容器日志；现在只打印文件路径，值不再进日志 |
| MCP Token | 否 | 只打印 `issued`，不打印值 |
| Provider Key | 否 | 容器验收只用 HN（无 Key）；`sk-VERIFY-*` 是测试夹具，响应只返回掩码 |
| 日志 / artifact | 低风险 | 报告目录只含结果、Trivy 输出、失败响应（无凭据）；container logs 不再含 setup token |
| Playwright trace | 低风险 | 失败时上传；本轮改为**每次随机**管理员密码，避免固定口令进入 artifact |
| pnpm 缓存 | 否 | 只缓存包 tarball |
| Docker GHA 缓存 | 否 | `.dockerignore` 排除 `.env`、`data/`、`*.db`；构建无 secret build-arg |
| `actions/checkout` | 否 | 全部 job 设置 `persist-credentials: false` |

**真实 Provider Key 的隔离**：`provider-live.yml` 只支持 `workflow_dispatch`，使用 `provider-live` Environment 的 secret；Docker 工作流**不引用**任何 provider secret。两者不会在同一次运行中同时拿到 Key 和无凭证验收环境。

> 注意：公开仓库的 Actions 日志与 artifact 对所有人可见。首次跑通前建议先把仓库设为 **private**，确认无泄漏后再转 public。

---

## 4. 代理 SSRF 边界复审（不能只看 CONNECT=0）

### 4.1 已能证明的部分

| 场景 | 行为 | 证据 |
|---|---|---|
| 目标字面量是回环/私网/CGNAT/元数据 | 请求前拒绝，代理 CONNECT=0 | `proxy-ssrf.test.ts`（12 个目标 × 2 种 trust） |
| allowlist 内的私网 + untrusted 代理 | 仍然拒绝 | 同上 |
| 元数据地址 + allowlist + trusted | 仍然拒绝 | 同上 |
| 重定向到私网/元数据/file | 每跳重新校验，代理不收到目标 CONNECT | `re-validates redirect hops` |
| `NO_PROXY` 命中 | 走直连，保留 connect-time 守卫 | `NO_PROXY` 用例 |
| 代理凭据 | 不可枚举、不打印、错误消息不含 userinfo | 凭据用例 |
| 管理端改代理 | settings API 不能改；代理只来自 env | `outbound-proxy.test.ts` |
| 内网模型 + untrusted 代理 | allowlist 也不放行 | 本轮新增用例 |

### 4.2 仍然无法证明、必须写进发布说明的部分

**代理侧 DNS 解析与本地校验不一致。** 应用解析 `rebind.public.test` 得到公网地址并通过校验，然后把 `CONNECT rebind.public.test:80` 交给代理；代理可以自行解析到 `127.0.0.1` 并连过去。应用看到的是“已验证的公网主机名 + 200 响应”，**无法发现代理实际连了内网**。

本轮新增了一个**故意暴露该盲区**的测试：

```text
tests/unit/proxy-ssrf.test.ts
  "does not trust the CONNECT target alone: a tunnel that answers from a private host is still a blind spot"
  → 断言请求成功、CONNECT 目标仍是 rebind.public.test、响应来自 127.0.0.1
```

它证明的是：**CONNECT 计数为 0 只覆盖“应用能识别的私网目标”，不覆盖“代理把公网名字解析到私网”**。因此：

- `untrusted` 的准确语义是「应用层校验 + 接受代理解析的残余风险」，不是「代理模式安全」。
- `trusted-networks` 的准确语义是「运维声明代理已实施 egress ACL」；没有 ACL 时不要声明。
- 不能把代理模式作为绕过 SSRF 的手段；需要内网目标时必须显式 allowlist + 直连，或 trusted-networks + 受控代理。
- 若未来要求消除该盲区，需要把 CONNECT 目标固定为本地解析出的 IP，并在 TLS 层单独设置 SNI；这是独立改动，不在本轮范围。

### 4.3 结论

代理模式**不能仅凭 CONNECT=0 被判为安全**。当前可交付的结论是：

1. 应用层能阻止的目标（字面量私网、私网解析、元数据、重定向）已全部覆盖；
2. 代理侧解析分歧是**已知残余风险**，已用测试固化、写入 `SECURITY.md` 与 `release-readiness.md`；
3. 公开测试版必须在文档中提示：使用代理前先确认代理自身的出站管控，或改用直连 + allowlist。

---

## 5. 远端初始化与首次推送方案（需用户执行 / 授权）

### 5.1 需要授予的权限

| 权限 | 用途 | 是否必需 |
|---|---|---|
| 创建仓库（个人或组织） | 建立 `search-hub` 空仓库 | 必需 |
| 仓库 Contents: Write | 首次 push | 必需 |
| Actions: 启用 + 默认 token 只读 | 运行工作流 | 必需 |
| Environments / Secrets: Admin | 配置 `provider-live`（可选） | 可选 |
| Branch protection: Admin | 把 CI/Docker 设为合并门禁 | 建议 |

不需要：组织级 admin、包发布权限、Release 权限、强制推送权限。

### 5.2 用户操作步骤（按顺序）

1. **创建空仓库**：`<owner>/search-hub`，**不要**勾选 README、LICENSE、`.gitignore`（避免与本地历史冲突）。
2. **（可选）配置真实 Provider 环境**：Settings → Environments → `provider-live`，添加 `TAVILY_API_KEY` / `BOCHA_API_KEY` / `BRAVE_API_KEY` 中的至少一个。
3. **确认仓库可见性**：首次验收建议 **Private**；确认日志/产物无泄漏后再改 Public。
4. **授权推送**（明确回复授权后再执行）：

```bash
cd C:/Users/TYMO001/WorkBuddy/ai聚合搜索
git remote add origin <仓库地址>
git branch -M main          # 历史不变，只改当前分支名
git push -u origin main     # 首次推送，非强推
```

5. **打开 Actions**，确认三个工作流出现在列表；若默认分支不是 `main`，在 Settings → Branches 改默认分支。
6. **手动触发容器验收**：Actions → Docker → Run workflow → 分支 `main`。
7. **（可选）设置分支保护**：Require status checks 选择 `CI / quality`、`CI / build`、`CI / e2e`、`CI / security`、`Docker / quality`、`Docker / e2e`、`Docker / container`；禁止 force push。
8. **（可选）跑真实 Provider**：Actions → Provider live verification → Run workflow → `auto`。

### 5.3 严禁事项

- 不使用 `git push --force` / `--force-with-lease`。
- 不删除或覆盖已有 Tag（当前无 Tag；首次发布前也不要创建）。
- 不创建 GitHub Release。
- 不把 `.env`、`data/`、`*.db`、`master.key` 加入版本库。
- 不把真实 Key 写进 workflow、脚本、文档或 artifact。

---

## 6. 首次远端验收要采集的证据

| 证据 | 位置 | 用途 |
|---|---|---|
| CI run URL | Actions → CI | 384 测试、typecheck、lint、E2E、audit、secret scan |
| Docker run URL | Actions → Docker | quality → e2e → container 全链路 |
| 镜像 digest / size | Docker job 日志 `image=... id=... size=...` | 发布说明 |
| 11 项验收结果 | job summary + `docker-verification-<run_id>` artifact | 逐项 PASS/FAIL |
| Trivy 报告 | artifact `vulnerabilities-*.txt` | HIGH/CRITICAL 计数 |
| 资源数字 | 脚本 item 8 输出 | 回填 `docs/docker-verification.md` §3.1 |
| MCP 证据 | 脚本 item 11 输出 | initialize / 9 tools / 真实 URL / REST 一致 |
| Provider live（可选） | Actions → Provider live verification | 升 `documented` → `live_tested` 的唯一依据 |

验收通过后，把 run URL、镜像 digest、Trivy 计数写入 `docs/docker-verification.md` 与 `docs/release-readiness.md`，并更新 AC-01/AC-09 状态。

---

## 7. 下一轮「CI 失败自动修复」流程

### 7.1 取失败证据

```bash
gh run list --workflow=CI --limit 5
gh run list --workflow=Docker --limit 5
gh run view <run-id> --log-failed
gh run download <run-id> -n docker-verification-<run-id> -D /tmp/docker-report
```

### 7.2 按失败 job 分类修复

| 失败位置 | 先做什么 | 本地等价命令 |
|---|---|---|
| `quality` / `security` | 看第一个 error，不猜 | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` |
| `e2e` | 下载 Playwright trace，看截图与请求 | `pnpm test:e2e` |
| `build`（prod-only） | 看 `check-runtime-imports` 或启动日志 | `pnpm build && pnpm install --prod && node scripts/check-runtime-imports.mjs` |
| `Docker / build` | 看 buildx 层错误 | 任意 Linux + Docker：`docker build -t search-hub:debug .` |
| `Docker / container` item 1–4 | 镜像/启动/初始化 | `bash scripts/docker-verify.sh` |
| item 5/5c | Provider 或 Key 掩码 | 看 `search-failure-*.json`、`docker compose logs` |
| item 6/7 | 重启/持久化 | 对比 job summary 的 providers/searches/key |
| item 8 | 资源 | `docker stats --no-stream` |
| item 9 | 崩溃恢复 | `docker kill` + `docker ps -a` + checkpoint |
| item 10 | Trivy | `trivy image --severity HIGH,CRITICAL <image>` |
| item 11 | MCP | 看 `mcp-*.json` 原始响应 |
| `provider-live` | 厂商 401/429/超时 | 本地 `provider-live.mjs --provider <name> --key ...` |

### 7.3 修复与重跑

```bash
# 修复后
pnpm typecheck && pnpm lint && pnpm test && pnpm build
git add -A && git commit -m "fix(ci): <具体失败项>"
git push origin main            # 需用户授权；普通 push，非强推
gh run watch <new-run-id>
# 仅基础设施抖动时重跑失败 job
gh run rerun <run-id> --failed
```

### 7.4 规则

- **不通过放宽断言、删除测试、跳过 job、加 `continue-on-error` 来变绿。**
- 外部网络/Registry/Trivy 下载失败：先 `gh run rerun --failed` 一次；仍失败再改配置或固定镜像源。
- 修复必须是新提交；**不 amend 已推送提交、不 force push**。
- 每轮最多自动修 3 个根因；超过则停下来报告，不盲目试错。
- 真实 Provider 失败不得用 Mock 结果替代；要么修适配器，要么保留 `documented`。

---

## 8. 结论与下一步

| 项 | 状态 |
|---|---|
| Git 历史可推送 | **是**（19 提交，无敏感信息，无 Tag/远端） |
| 工作流 `workflow_dispatch` | **是**（三个工作流都有） |
| 失败阻断链 | **是**（quality/e2e → container；Trivy 失败即 fail；无 continue-on-error） |
| 全新 Runner 依赖 | **已按 Ubuntu 预装 + 固定版本审计**；未实际运行 |
| CI 凭据泄漏面 | **已修 3 处**（setup token 日志、E2E 固定密码、历史扫描缺失） |
| 代理 SSRF | 应用层覆盖完整；**代理侧 DNS 分歧为已知残余风险**，有测试与文档 |
| Docker 容器验收 | **仍未执行**（本机无 Engine） |
| 真实 Provider | HN 已联调；Tavily/Bocha/Brave/SearXNG 仍 `documented` |

**下一步只有一件事：在获得授权后创建远端并推送，让 `Docker` 工作流真正跑一次。** 在拿到 run URL、镜像 digest、11 项结果和 Trivy 报告之前，对外结论保持 **CONDITIONAL**。
