# v0.1.4-beta.6 发布报告

| 项 | 值 |
|---|---|
| 合并 PR | #10（修复）、#11（发布流水线）、#12（镜像 tag）、#13（v0.1.5 方案） |
| 发布分支 SHA | `ff61af7`（PR #10 + #11 合并后的 main） |
| Tag | `v0.1.4-beta.6` → `ff61af7` |
| Release | https://github.com/alicia1030su/search-hub/releases/tag/v0.1.4-beta.6 |
| 发布后 main | `84f1010`（#12、#13 的后续文档修复） |

Tag 指向的是"代码 + 发布流水线"都齐备的那个 SHA。之后的 #12/#13 只改
workflow 的镜像 tag 语义与新增规划文档，不需要重新打 Tag 或重发资产。

## 各平台验收（均为真实执行）

| 平台 | 运行环境 | 结果 | 证据 |
|---|---|---|---|
| Windows x64 | `windows-latest` + Node SEA | **PASS** | 解压 → `SearchHub.exe` 启动 → health → setup 200 → REST 3 条 → MCP initialize/tools.list/tools.call → db + master.key → stop → restart 管理员仍在 |
| Linux x64 | `ubuntu-latest` + 随包 x64 运行时 | **PASS** | 同一套 `verify-package.mjs`，同一包内布局 |
| Linux arm64 | `ubuntu-24.04-arm` + 随包 arm64 运行时 | **PASS** | 同上，原生 arm64 执行 |
| Docker / compose | `ubuntu-latest` | **PASS** | 24/24 容器检查，Trivy CRITICAL=0 HIGH=0 |
| GHCR 镜像 | 由 Tag SHA 构建 → 启动 → 健康检查 → 推送 | **PASS** | `ghcr.io/alicia1030su/search-hub:0.1.4-beta.6`，digest `sha256:b171822e…` |

Windows 启动器独立 CI job（新增）：12 项生命周期断言通过。

## 资产

| 文件 | 大小 | SHA256（前 16 位） |
|---|---|---|
| `search-hub-v0.1.4-windows-x64.zip` | 73,998,129 | `fafc24e47b46d2fa` |
| `search-hub-v0.1.4-linux-x64.tar.gz` | 49,504,707 | 见 `SHA256SUMS` |
| `search-hub-v0.1.4-linux-arm64.tar.gz` | 49,335,665 | 见 `SHA256SUMS` |
| `SHA256SUMS` | 304 | — |

发布流水线在上传后重新下载全部资产并执行 `sha256sum -c SHA256SUMS`：
`verified 4 files including SHA256SUMS`。

本机再次下载 `windows-x64.zip` 时被网络代理反复截断（最大仅到 ~11 MB，
SHA 不匹配），因此本机未能完成"下载后"的黑盒；改为
**从 Tag 对应的 SHA 本地重建同源产物**（`ff61af7` + `PACKAGE_TARGET=windows-x64`），
对它执行完整的 `verify-package.mjs`（16 项全 PASS）与黑盒缺陷复测
（A1 → 503/failed、A5 → 404 无泄漏）。这与已上传资产是同一次构建输入，
但不是同一份二进制——差异必须如实记录。

## 安全修复验证（在 beta.5 与 beta.6 产物上对照）

```
beta.5 → 200 completed results=0        |  beta.6 → 503 failed results=0
beta.5 → bob reads alice's task: 200    |  beta.6 → 404 leaked=no
```

## beta.5 处理

Release 说明已更新为「Superseded by v0.1.4-beta.6」，列出该版本已证实的访问控制缺陷。
**Tag、资产、Release 本体全部保留未动。**
