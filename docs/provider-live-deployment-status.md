# `provider-live` Deployment 红叉说明

Docker/Deployments 页面上 `provider-live` 环境的红色失败，长期没有解释。
这里把它拆成**两种完全不同的原因**，避免把它误读成"生产部署失败"或"软件有 bug"。

## 结论先行

**这个工作流从不部署任何东西。** 它只调用厂商 API 来验证适配器。
`environment: provider-live` 只是用来隔离密钥的作用域，不是生产环境。
所以它的红叉**既不是生产部署失败，也不是程序缺陷**。

## 原因一：分支保护拒绝（运行根本没开始）

运行 [43616441125](https://github.com/alicia1030su/search-hub/actions/runs/43616441125)：

```
X Branch "docs/real-search-validation-plan" is not allowed to deploy
  to provider-live due to environment protection rules.
X The deployment was rejected or didn't satisfy other protection rules.
```

`provider-live` 环境的 deployment branch policy 是 `custom_branch_policies: true`，
且只允许 `main`。那次是 `workflow_dispatch` 从功能分支触发的，所以被挡在门外。

- 作业步骤数：**0**（一个都没跑）
- 含义：配置/触发方式问题，不是凭证问题，也不是程序问题
- 处理：从 `main` 重新触发；不要为了跑通去放宽环境的分支策略

## 原因二：没有配置真实 Provider 凭证（运行了，但没调用任何厂商）

运行 [43613257891](https://github.com/alicia1030su/search-hub/actions/runs/43613257891)：

```
TAVILY_API_KEY: (empty)
BOCHA_API_KEY: (empty)
BRAVE_API_KEY: (empty)
SKIP: tavily has no secret in the provider-live environment
SKIP: bocha has no secret in the provider-live environment
SKIP: brave has no secret in the provider-live environment
providers called: 0, failures: 0
##[error]No provider secret is configured for this run
```

这是**真实搜索厂商联调失败**——准确地说是**无法执行**，因为没有任何 Key。

- 作业步骤数：5（安装依赖后停在第 5 步）
- 含义：三个适配器仍是 `documented`，不是 `live_tested`
- 处理：在 `provider-live` 环境配置 `TAVILY_API_KEY` / `BOCHA_API_KEY` / `BRAVE_API_KEY`
  之一，然后从 `main` 重新触发

## 为什么保留红色，而不是改成"跳过"

把 `exit 1` 改成 `exit 0`（或 `continue-on-error`）会让这个运行变绿，
但那样传达的信息是"厂商联调通过"——而实际上一次真实调用都没发生。
**"无法验证"不等于"验证通过"。** 所以：

- 缺凭证时仍然非绿（exit 1），
- 但 Job Summary 现在会明确写出 **BLOCKED (no credential)**、缺哪几个 secret、
  以及"这不代表程序或镜像有问题"。

工作流已经改进为输出结构化摘要（见 `.github/workflows/provider-live.yml`
的 `GITHUB_STEP_SUMMARY` 段落），红叉点进去就能看到原因，不必再翻日志。

## 与发布的关系

`v0.1.4-beta.6` / `v0.1.5-beta.1` 的发布流水线（`Release packages`）**不依赖**
`provider-live`。它验证的是"装好的程序能不能起来、REST/MCP 能不能用"，
用的是本地 mock 源，不消耗任何厂商额度。两个工作流相互独立：

| 工作流 | 验证什么 | 需要真实 Key |
|---|---|---|
| `CI` | 类型、lint、单测、集成测试、E2E | 否 |
| `Docker` | 镜像构建、compose、容器内 11 项验收 | 否 |
| `Release packages` | 三平台安装包构建 + 启动验收 | 否 |
| `provider-live` | 真实厂商 API 调用 | **是** |

## 当前各 Provider 的真实验证状态

以 catalog 为准（`node scripts/generate-provider-matrix.mjs` 生成）：

| 状态 | 数量 | 含义 |
|---|---|---|
| `live_tested` | 4 | hackernews / crossref / openalex / pubmed，有 `docs/live-evidence/*.json` |
| `documented` | 45 | 已实现，从未用真实 Key 调过 |
| `mock_verified` | 1 | `mock`，只证明代码路径 |
| `unverified` | 7 | generic 预设，需要用户自己填端点 |
| `no_official_api` | 1 | `baidu` |
