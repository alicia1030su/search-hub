# v0.1.5-beta.1 发布报告

| 项 | 值 |
|---|---|
| 合并 PR | #15（功能）、#16（版本与文档） |
| 发布 SHA / Tag | `c5f7a8c` / `v0.1.5-beta.1`（同一 commit） |
| Release | https://github.com/alicia1030su/search-hub/releases/tag/v0.1.5-beta.1 |
| CI / Docker | 该 SHA 上均 success |
| 测试 | 633 Vitest（新增 49）、17 Playwright、12 启动器断言 |

## 一、新功能

### 搜索源健康管理

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 配置完整性 / 网络 / TLS / 鉴权 / 权限 / 限流 / 余额 / 有效性 / 延迟 分级 | `health-classify.ts` | 9 类 cause，各有不同的冷却与状态映射 |
| 免费连接探测 vs 付费真实搜索 | `health.ts` | `connect` / `search` 两种 kind，分别记录 |
| 无凭证 = 未验证 | `health.ts` | 返回 `unverified`，绝不返回 `healthy` |
| 200 但零结果 = 降级 | `health.ts` | `empty_results` |
| 每实例：状态 / 最近检测 / 最近成功 / P50 / P95 / 成功率 / 连续失败 / 最近错误 / Key 可用数 | `overview()` | 健康表 + 搜索事件聚合 |
| 24h 趋势 | `trend()` | 小时桶 |
| 一键测试单个 / 全部 | `POST /api/admin/health/check` | 串行 + 间隔，避免同时打满所有供应商 |
| 费用闸门 | `decideBudget` | per-run + per-day，请求**前**判断 |

### 故障切换

- `quota_exhausted` 在 `key-scheduler` 中是终态，不换同账户的 Key。
- 实测：一好一坏 → `partial` + `failedSources`；全坏 → `failed` + 0 结果。

### MCP 协议

实测结论（`docs/mcp-protocol.md`）：

```
request 2025-11-25 -> negotiated=2025-11-25
request 2026-07-28 -> negotiated=2025-11-25   ← 降级，不支持
```

- 后台显示 `revision2026Supported: false` 并说明原因，**不声称兼容**。
- 三类更新（协议 / SDK / 程序）分开呈现；失败报 unknown。
- `tools/list_changed` 不发（工具目录静态，发了就是假的）。

### Agent Skills

| Skill | 校验结果 |
|---|---|
| `search-web` | valid，0 error 0 warning |
| `deep-research` | valid，0 error 0 warning |
| `research-with-citations` | valid，0 error 0 warning |

校验规则：名称格式/长度/目录一致、description ≤1024、compatibility ≤500、
引用文件必须在技能目录内、符号链接不得逃逸、SKILL.md ≤500 行。

### 程序更新

- 校验和取自发布元数据的 `sha256:` digest，不信任随包 SHA256SUMS。
- 尺寸不符 / 缺 digest / 哈希不符 → 拒绝并删除。
- Docker → 直接拒绝，提示拉新 tag。

## 二、三平台安装包

| 平台 | 文件 | 大小 | 验收 |
|---|---|---|---|
| Windows x64 | `search-hub-v0.1.5-windows-x64.zip` | 74,015,074 | PASS |
| Linux x64 | `search-hub-v0.1.5-linux-x64.tar.gz` | 49,522,571 | PASS |
| Linux arm64 | `search-hub-v0.1.5-linux-arm64.tar.gz` | 49,355,283 | PASS |

验收内容：解压 → 启动（PATH 中移除 node/pnpm）→ health → 首次初始化 →
创建 Provider → REST 搜索（3 条）→ MCP initialize / tools.list / tools.call →
数据库与主密钥落盘 → 停止 → 重启后管理员仍在。

`SHA256SUMS` 由流水线上传后重新下载校验：`verified 4 files including SHA256SUMS`。

## 三、GHCR

`ghcr.io/alicia1030su/search-hub:0.1.5-beta.1`
（先构建、启动、健康检查，通过后才推送；未打 `latest`）

## 四、明确未完成

| 项 | 状态 | 原因 |
|---|---|---|
| Skills over MCP（`skills/list`、`skills.attach()`） | **未实现** | 当前 SDK 无该扩展的运行时导出，属实验性特性；需要特性开关 + 独立验收 |
| 启动器侧安装器（替换 + 回滚） | **未实现** | 不能在服务运行时覆盖自身文件，需独立更新器进程 |
| MCP 2026-07-28 | **不支持** | SDK 未实现，实测降级为 2025-11-25 |
| 真实厂商健康状态 | **unverified** | 环境中无付费 Key |

这四项都没有被写成"已完成"。
