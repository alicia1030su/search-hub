# `provider-live` 工作流状态说明

`provider-live` 只做真实厂商 API 调用，不部署任何东西。它通过
`workflow_dispatch` 手动触发，与 CI、Docker、Release 工作流相互独立。

## 当前行为（v0.1.17）

- `auto` 默认运行三个无需 Key 的公开源：`wikipedia`、`arxiv`、`github`。
- 配置了 `TAVILY_API_KEY` / `BOCHA_API_KEY` / `BRAVE_API_KEY` 时，`auto`
  也会运行对应付费源；缺少 Secret 时打印 `SKIP`，不会假装通过。
- 每个源使用两个最小查询，输出脱敏的 `evidence-<provider>.json`，包含源码
  Commit、适配器版本、HTTP 状态、结果数、样例 URL、耗时与逐次尝试。
- 日志与证据在上传前会再次脱敏；任何失败都会使工作流非绿。

## 红叉的常见含义

| 红叉原因 | 含义 | 处理 |
|---|---|---|
| 环境分支策略拒绝 | 运行未开始，通常是从非 `main` 分支 dispatch | 从 `main` 重新触发，不放宽环境策略 |
| 厂商返回 401/403 | 凭证无效或权限不足 | 检查 `provider-live` 环境 Secret |
| 厂商返回 429 | 触发厂商限流 | 等待后重试，不提高并发 |
| HTTP 200 业务错误 | 响应体表示失败 | 依据 evidence 中的错误修复适配器 |
| 返回空结果 | 源当前不可用或查询无结果 | 保持 `documented`，不得提升 `live_tested` |

## 与发布的关系

发布门禁不依赖 `provider-live`。Release 包使用本地 mock 源验证安装、REST、
MCP 与灾难恢复；`provider-live` 只证明适配器曾成功调用真实厂商。

| 工作流 | 验证什么 | 需要真实 Key |
|---|---|---|
| `CI` | 类型、lint、单测、集成测试、E2E | 否 |
| `Docker` | 镜像构建、compose、容器内 11 项验收 | 否 |
| `Release candidate` | 三平台包、CLI、systemd、GHCR 与证据 | 否 |
| `provider-live` | 真实厂商 API 调用 | 视 Provider 而定 |

## 当前真实验证状态

以 `docs/provider-matrix.md` 与 `docs/live-evidence/` 为准：

| 状态 | 数量 | 说明 |
|---|---|---|
| `live_tested` | 7 | Hacker News、Crossref、OpenAlex、PubMed、Wikipedia、arXiv、GitHub |
| `documented` | 42 | 已实现，但没有符合证据标准的真实调用 |
| `mock_verified` | 1 | `mock`，只证明代码路径 |
| `unverified` | 7 | generic 预设，需要用户自己填端点 |
| `no_official_api` | 1 | `baidu` |

一次手动探测成功不会自动改变 catalog 的验证等级；必须同时提交可复查的
`docs/live-evidence/<provider>.json`，并通过文档一致性门禁。
