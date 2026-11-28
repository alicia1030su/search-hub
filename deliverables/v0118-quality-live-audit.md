# v0.1.18 真实 ABBA 搜索质量证据审计

审计日期：2026-11-28。审计基线：`feat/v0118-search-core`，审计时 HEAD `da69d13`。本报告不宣称质量提升。

## 1. 结论

现有 `scripts/quality-live.mjs` 在本次补齐前只能固定发送 `mode=basic`。现已支持 `suites[]` 逐 suite 串行 ABBA，按 suite 冻结 `basic/rrf/rerank/deep` 请求、limit、perProviderLimit 与非密 modelArtifacts，输出 suiteId；未提供 suites 时兼容旧 basic manifest。原始 per-provider 行、最终排名、哈希、请求数和延迟均来自真实响应，不预填分数。脚本只负责原始证据；B8 `observed/releaseScore/attrition` 报告由 `scripts/quality-report.mjs` 从冻结 queries/labels 与原始 report 生成，多 suite 不合并 bootstrap。

当前环境**不能产出有效的 v0.1.17/v0.1.18 ABBA 质量结论**，原因如下：

1. `tests/fixtures/quality-v0118/queries.json` 已存在 40 条冻结真实查询与 80 条 labels；本次已补充 `scripts/quality-live.public.example.json` 的 live manifest 形状。仍需按实际实例填写 Provider ID、exact commits、区域与非密配置指纹。该 labels 文件明确不声明 qrels 完整，因此 Recall 不可计算，也不能把它描述为两名标注者仲裁后的完整 qrels。
2. 没有同实例、同区域、同 origin 的双实现路由；当前 API 本身不提供 v0.1.17/v0.1.18 并行入口。
3. 没有本地 `data/` 数据库、`SEARCH_HUB_TOKEN` 或相关 Provider/模型凭证环境变量。
4. 两个无凭证公开 Provider 的真实冒烟均失败：Wikipedia 10,700ms 网络错误，DuckDuckGo 223ms 网络错误。失败证据已保存，不得解释为空结果或质量 0。

因此现阶段只能确认协议实现与失败事实，不能确认任何 nDCG/MRR/P/Recall 提升。

## 2. 覆盖矩阵

| 证据 | 脚本能力 | 限制 |
|---|---|---|
| basic | 支持 `request.mode=basic` | 需可用的公开/自托管搜索 Provider |
| rrf | 支持 `request.mode=rrf` | 与 basic 使用相同 Provider 集合和召回参数 |
| rerank | 支持 suite `request.mode=rerank`、`rerankModelId` | 两侧必须冻结可用 rerank 模型；缺模型时 suite 记 `skipped/missing_rerank_model`，不发送请求 |
| deep | 支持 suite `request.mode=deep`、`maxSubqueries`、`maxRounds`、`queryExpansion` | 保存 deepRounds 与预算；缺 chat metadata 时记 `chat_model_not_frozen` limitation，是否可运行由实现能力决定 |
| v0.1.17/v0.1.18 | 通过同 origin 不同路径的代理路由接入两个 exact-SHA 实例 | 仓库不内置双实现路由，需按下节部署 |
| 同快照重排 | 由 `quality.ts` 的 offline `snapshotRunId` 回放负责 | 不与 live ABBA 合并统计 |
| live 比较 | `scripts/quality-report.mjs` 消费原始 live report 与冻结 queries/labels | labels 不声明完整时 Recall 为 N/A；不得补造分数 |

请求白名单禁止覆盖 `query/providers/limit/perProviderLimit/skipCache`，并禁止同时冻结 `mode` 与 `strategy`。缺少 `debug.perProviderResults` 的响应记为 `missing_per_provider_evidence`，不能当作成功空结果。

## 3. 已执行的公开 Provider 冒烟

均为单实现、无凭证、非 ABBA 证据：

- `deliverables/quality-public-smoke-wikipedia.json`：失败，网络错误，10,700ms，SHA-256 `0cb358f11c087cc247971b5c47c030f8903f6c8bbc925d70e3688830f27934e6`。
- `deliverables/quality-public-smoke-duckduckgo.json`：失败，网络错误，223ms，SHA-256 `3cec3a897e39f4a01aa12fb5984cf4d0077de2b49ab5d2ef4d49cf801b4aeda2`。

复现命令：

```bash
node --import tsx scripts/quality-public-smoke.mjs --provider wikipedia --query "search engine" --out deliverables/quality-public-smoke-wikipedia.json
node --import tsx scripts/quality-public-smoke.mjs --provider duckduckgo --query "search engine" --out deliverables/quality-public-smoke-duckduckgo.json
```

两条命令均以 exit 4 结束，表示真实 Provider 冒烟失败。当前 shell 的 `NODE_TLS_REJECT_UNAUTHORIZED=0`，TLS 证书校验被环境禁用；因此这些失败记录不能作为 TLS 安全证据，正式评测应在该变量为 unset 的环境中重跑。

没有调用任何付费厂商，没有使用或生成凭证。

## 4. 双实例同 origin 部署步骤

以下命令是复现步骤，**尚未在当前环境执行**。将 `<v0117-sha>` 固定为 `ea0a35dea23517584b29995fcaae4d5b7fdaf8f6`，`<v0118-sha>` 固定为待发布 exact SHA。

```bash
git worktree add ../search-hub-v0117 <v0117-sha>
git worktree add ../search-hub-v0118 <v0118-sha>
pnpm --dir ../search-hub-v0117 install --frozen-lockfile
pnpm --dir ../search-hub-v0118 install --frozen-lockfile
pnpm --dir ../search-hub-v0117 build
pnpm --dir ../search-hub-v0118 build
```

两个实例使用同一台主机/区域、相同公开 Provider 集合与非密配置，分别使用独立数据目录和端口。`SEARCH_HUB_TOKEN` 需在两侧配置为同一个仅含 `search`（如用 sources 读取则另加 `sources:read`）scope 的令牌；不要写入 manifest 或报告。

```bash
SEARCH_HUB_DATA_DIR=$PWD/.quality-v0117 SEARCH_HUB_PORT=8787 pnpm --dir ../search-hub-v0117 start
SEARCH_HUB_DATA_DIR=$PWD/.quality-v0118 SEARCH_HUB_PORT=8788 pnpm --dir ../search-hub-v0118 start
```

在同 origin 的 HTTPS 反向代理上配置路径前缀剥离，例如 Caddy：

```caddyfile
quality.internal {
  handle_path /v0117/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle_path /v0118/* {
    reverse_proxy 127.0.0.1:8788
  }
}
```

先分别验证 `/v0117/api/search` 与 `/v0118/api/search` 可用，且响应来自预期 exact-SHA 构建。

## 5. 冻结输入

公开 Provider 示例 manifest 为 `scripts/quality-live.public.example.json`。它通过 `queriesFile: "../tests/fixtures/quality-v0118/queries.json"` 引用现有 40 查询，不复制查询正文；basic/rrf suite 启用，rerank/deep suite 显式 disabled 并记录原因。运行前必须替换区域、实际 Provider ID、exact commits 和非密配置指纹。

suite 结构：

```json
{
  "id": "rrf-public",
  "request": { "mode": "rrf" },
  "limit": 20,
  "perProviderLimit": 20,
  "modelArtifacts": {}
}
```

每个 suite 使用同一 Provider 集合与两侧非密配置，完整执行 40 查询的 AB/BA 后才进入下一个 suite。未提供 `suites[]` 时兼容旧 manifest，默认 `legacy-basic`。`rerank` 缺少冻结模型 metadata/`rerankModelId` 时记 `skipped/missing_rerank_model`；`deep` 缺少 chat metadata 时记 limitation，不能伪造模型已执行。

`tests/fixtures/quality-v0118/queries.json` 中的 80 条 labels 是冻结评测输入，但文件明确不声明 qrels 完整，因此 Recall 不可计算。`quality-report.mjs` 直接消费该冻结文件与原始 live report；不得把这些 labels 改写为完整 qrels 或为未标注文档填 0。

## 6. 精确执行命令

完成第 4、5 节后，在工作树根目录执行：

```bash
cp scripts/quality-live.public.example.json /secure/path/quality-live.json
# 编辑 /secure/path/quality-live.json：替换 region、Provider ID、两侧 commit 与配置指纹。
export SEARCH_HUB_TOKEN='<search-scope-token>'
node --import tsx scripts/quality-live.mjs \
  --manifest /secure/path/quality-live.json \
  --baseline-url https://quality.internal/v0117/api/search \
  --candidate-url https://quality.internal/v0118/api/search \
  --out deliverables/quality-live-public
```

输出 `quality-live-report.json`：suiteId、AB/BA 顺序、每次尝试、原始 per-provider 快照、最终排名、请求数、延迟、错误、降级、hashes 与 provenance。随后由报告 worker 生成比较结果：

```bash
node --import tsx scripts/quality-report.mjs \
  --queries tests/fixtures/quality-v0118/queries.json \
  --live deliverables/quality-live-public/quality-live-report.json \
  --credential-scope public \
  --out-dir deliverables/quality-live-public/report
```

仅当报告为 `SUPPORTED`、两种口径方向一致且满足预注册门槛时，才可讨论提升；当前环境未达到该状态。
