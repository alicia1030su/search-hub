# Search Hub v0.1.18 搜索实验室 UI 增量规格

## 1. 范围与原则

本规格只改现有 `/lab` 搜索实验室，不新增路由、导航项或无关页面。目标是让管理员在一个页面完成策略选择、真实搜索、过程观察、排名诊断和正文查看。

硬约束：

- 复用现有 Vite + React + MUI/Tailwind 风格与 `components/ui.tsx` 基础组件；不引入新 UI 框架或图表库。
- 旧 `mode` 请求继续可用；新 `strategy` 与旧 `mode` 不得同时发送。
- 流式临时结果必须与最终结果在视觉和语义上分离；临时结果不进入复制/导出的最终 JSON。
- 正文按需读取，默认 HTTP 提取，不默认启动 Chromium，不自动抓取全部结果。
- 所有新增状态必须有加载、取消、错误、空态；不得用 0、绿色勾或模拟进度掩盖未知。
- 中英文同批更新；颜色不是唯一状态信号。

## 2. 信息架构

保持现有左右两栏：

```text
/lab
├─ PageHeader：标题、版本/实验提示
├─ 左栏：查询与运行控制
│  ├─ 查询词
│  ├─ 策略/旧模式选择器
│  ├─ Provider 自动/手动选择
│  ├─ 高级参数（扩展、语言、时效、模型、缓存）
│  └─ 运行 / 取消
├─ 左栏：任务 ID 加载/取消（保留）
└─ 右栏：运行与结果
   ├─ 实时进度与路由解释
   ├─ 查询扩展 / Deep 子查询
   ├─ 结果摘要、延迟、缓存、候选漏斗
   ├─ 来源贡献
   ├─ 重排前后对比（有数据时）
   ├─ 最终结果 / 临时结果
   ├─ 模型回答与摘要（沿用）
   └─ 调试详情（沿用）
```

正文查看使用覆盖在当前页面的 Drawer，不跳转新页面；`App.tsx` 与 `app-shell.tsx` 不新增 route/nav。

## 3. 策略预设与旧模式兼容

### 3.1 单一选择器

将当前 `lab.mode` 下拉改为一个带 `optgroup` 的选择器。为避免新旧 `deep` 值冲突，option value 统一编码为 `strategy:<value>` 或 `mode:<value>`：

- **策略预设**：`strategy:auto`、`strategy:fast`、`strategy:balanced`、`strategy:quality`、`strategy:deep`。
- **旧模式兼容**：`mode:web`、`mode:grounded`、`mode:research`、`mode:basic`、`mode:rrf`、`mode:rerank`、`mode:embedding`、`mode:embedding_rerank`、`mode:rerank_summary`、`mode:deep`。

规则：

1. 选择策略时只发送 `strategy`，不发送 `mode`。
2. 选择旧模式时只发送 `mode`，不发送 `strategy`。
3. 两者同时存在属于非法请求，UI 不得构造；服务端 400 原样展示。
4. 保留当前 Lab 本地默认 `rrf`，不因 SettingsService 默认 `basic` 而静默改变既有 Lab 行为。
5. 策略名称旁显示一句话说明，并在切换时更新高级参数可用性。

| 策略 | UI 说明 | 扩展 | Rerank | Deep |
|---|---|---|---|---|
| Fast | 单轮、最低延迟 | 强制关闭 | 不启用 | 不启用 |
| Balanced | 日常推荐，RRF 融合 | 可选，默认关闭 | 可选 | 不启用 |
| Quality | 更大候选池，模型重排优先 | 可选，默认关闭 | 有模型则用，无模型明确降级 | 不启用 |
| Deep | 有界多轮、多查询融合 | 可选，默认关闭 | 可选 | 最多 4 子查询、2 轮 |
| Auto | 按本地规则选择，并解释原因 | 命中规则且用户开启才启用 | 依选中策略 | 依选中策略 |

### 3.2 旧模式兼容提示

- 旧模式仍使用现有非流式 `api.search()`，避免改变旧客户端语义。
- `rerank/embedding/embedding_rerank/rerank_summary` 缺少对应模型时显示阻断提示：“旧模式要求该模型，不能自动降级”；运行按钮禁用或允许点击后展示服务端 400，二者必须一致。
- 新策略缺少可选模型时允许运行，并在运行前/响应中显示 `degradations`，不得伪装成模型已执行。
- 旧 `deep` 继续走 `/api/search/deep`；新 `strategy=deep` 走策略流式端点。

## 4. Provider 自动选择

### 4.1 自动/手动模式

在 Provider 卡片顶部增加分段控件：

- **自动选择（推荐）**：默认用于新策略；请求不发送 `providers`，由服务端选择。
- **手动选择**：沿用现有复选框、全选、清空。

自动模式的本地预检只用于提示，不替代服务端结果：

- 可参与条件：enabled、能力匹配、适配器可用、需要凭证时有可用 Key。
- 最多展示/选择 8 个候选 Provider；不可用 Provider 显示原因，不静默消失。
- 不因当前不健康而本地剔除；健康门禁和失败来源由服务端如实返回。
- `meta.selectedProviderIds` 是本次运行的权威列表；到达后替换本地预估并展示 `requested/selected` 数量。

### 4.2 组件行为

- 自动模式时复选框禁用但保留可见，便于看出哪些源被排除及原因。
- 手动模式至少选择 1 个 Provider；0 个时阻止运行并聚焦 Provider 区。
- Provider 加载失败、空列表、全部无可用 Key 使用不同空态/错误态。
- 自动模式运行后展示路由决策与选择理由；不得只显示“自动”而无解释。

## 5. 实时进度与流式结果

### 5.1 传输

- 新策略默认使用 `POST /api/search/stream`，Accept `text/event-stream`。
- 保留非流式回退：仅在服务端明确返回 404/405/unsupported 时回退，并提示“当前服务不支持流式，已使用非流式”；网络错误、500、取消不得回退。
- `api.searchStream()` 必须处理 SSE/NDJSON 两种 content type、分块解码、心跳、CSRF、abort 和流内 error。
- 旧模式不默认流式；任务 ID 加载/取消卡片保留。

### 5.2 进度阶段

进度区展示服务端 `status` 事件：

```text
routing → fanout → dedupe → rerank/embedding（可选） → finalizing → done
```

- 有 `completed/total` 时显示确定进度；没有时显示不定进度，禁止编造百分比。
- Provider 扇出阶段逐源显示 pending/running/success/failed/skipped、耗时和结果数。
- 心跳只维持连接，不更新阶段、不产生假进度。
- `aria-live="polite"` 播报阶段变化，不为每个结果刷屏。
- 客户端耗时持续显示；服务端耗时到达后并列显示，不相互冒充。

### 5.3 临时与最终结果

- `results` 事件：卡片使用虚线边框、半透明背景和“临时结果”徽章；顶部显示“仍在运行，排名可能变化”。
- `done` 事件：原子替换临时列表，移除虚线/临时徽章，显示“最终结果”和最终计数。
- 最终快照必须包含完整 `results/stats/errors/failedSources/strategy/route`；不得由客户端拼接临时事件生成最终 JSON。
- 临时结果不写入缓存、不写入任务历史、不参与复制/下载。
- 取消后保留已到达的临时结果，但整区标记“已取消，非最终结果”；不得显示最终徽章。
- 缓存命中只显示最终结果与完成状态，不播放伪造的临时增量。

## 6. 查询扩展与 Deep 子查询

- 高级参数增加“自动查询扩展”开关，默认关闭；说明“最多生成 3 个扩展查询，始终保留原查询”。
- 开关仅在 Balanced/Quality/Deep 显示；Fast 隐藏并禁用。
- 未配置可用 Chat 模型时显示 warning：“未配置扩展模型，将仅使用原查询”，运行不被阻断。
- 运行后展示查询 chips：原查询、扩展/改写查询、语言、权重、轮次；重复查询只显示一次并标记“已去重”。
- Deep 模式额外显示预算：实际子查询数/4、轮数/2、Provider-query 调用/32、HTTP 请求/64；达到上限显示“预算耗尽，返回已有结果”。
- 每条结果可展开 `queryOrigins`，显示哪些子查询、哪些 Provider、什么名次找到该文档。
- 不把扩展查询当作用户原始查询；复制/导出请求时保留两者区别。

## 7. 来源贡献

在现有“逐源统计”卡片增加来源贡献区：

| 列 | 含义 |
|---|---|
| 原始条数 | 该 Provider 返回的候选数 |
| 去重丢弃 | 因精确 URL/近标题被合并的条数 |
| 最终贡献 | 最终结果 `sources` 中出现该 Provider 的文档数 |
| Top K 贡献 | 该 Provider 贡献的最终前 `min(10, 最终结果数)` 条文档数 |
| 失败/跳过 | 错误码、未发送原因或预算跳过 |

- 用横向条展示“最终贡献 / 最终结果数”，条长按数量计算，不使用相关性颜色。
- 分数贡献只有服务端提供逐源融合分时才显示；缺失显示“—”，不得用原始 Provider 分数替代。
- 明确文案：“来源贡献表示出现频次，不代表相关性或质量。”
- Deep 模式可切换到“按子查询查看贡献”，使用 `queryOrigins` 聚合。

## 8. 重排前后对比

- 仅当响应提供 `debug.rerankComparison` 时显示“重排前后对比”。
- 双列排名：左“重排前”、右“重排后”；中间/行内显示 `↑n`、`↓n`、`新进入`、`移出`、`不变`。
- 文档身份使用规范化 URL；单侧存在时位次为“—”，不显示 `0` 或 `Infinity`。
- 默认展示 top 20 位移，更多显示“另有 N 条”；筛选器支持全部/仅变化/仅进入移出。
- 未标注文档不得被描述为质量变化；本页只展示排名事实。
- 未应用 Rerank 时隐藏对比卡并显示说明：“本次未执行重排”；服务端未提供对比数据时显示“无对比数据”，不得用最终列表倒推重排前排名。
- 移动端双列改为上下两区，保留同一文档的移动徽章。

## 9. 正文查看

### 9.1 入口与按需读取

- 每条结果增加“查看正文”按钮；只有用户点击才调用 `POST /api/web/read`。
- 不在搜索完成后自动抓取所有 URL，不预取下一页。
- Drawer 展示：标题、规范化 URL、读取状态、提取器、是否截断、正文文本、抓取耗时、缓存状态（若提供）。
- 提供“打开原网页”“复制正文”“重试”；不渲染原始 HTML。

### 9.2 状态与降级

- 加载中显示 skeleton 和“正在读取正文”。
- `ok + truncated` 显示 warning 并保留已读取文本。
- `login_required/captcha/maintenance/not_found/unsupported` 显示对应原因和下一步建议，不显示空白成功页。
- 网络错误、超时、SSRF 阻止分别显示稳定错误码；不得显示原始堆栈。
- `render=true` 默认关闭，只有管理员能力明确启用时才显示开关；开启后标注“将启动隔离浏览器，资源占用更高”。
- Drawer 关闭时取消未完成读取；同一 URL 重复打开可复用本次页面会话结果，但不跨用户持久化。

## 10. 延迟、缓存与候选漏斗

### 10.1 延迟

- 展示服务端 `totalMs`、客户端耗时、fanout/fusion/rerank/embedding/summary 各阶段。
- Provider 表展示每源延迟、尝试次数、结果数和错误。
- 单次运行不展示 P50/P95；没有数据时显示“—”。

### 10.2 缓存

高级参数增加缓存选择：

- **绕过缓存（默认）**：发送 `skipCache=true`，适合实验对照。
- **允许缓存**：发送 `skipCache=false`。

状态徽章：

- 请求绕过：始终显示“已绕过缓存”。
- `stats.cached=true`：显示“缓存命中”。
- 允许缓存且 `stats.cached=false`：显示“未命中”。
- 字段缺失：显示“未知”，不得写成命中或未命中。

### 10.3 候选漏斗

展示 `stats.funnel`：原始、非法丢弃、精确/近标题去重、候选截断、重排序输入、最终返回。计数必须满足 PRD B1 恒等式；不一致时显示 warning 和原始计数，不静默修正。

## 11. 取消、错误与空状态

| 场景 | UI 行为 |
|---|---|
| 运行前无查询 | 行内错误 + 聚焦查询框 |
| 无可用 Provider | 空态 + 前往 Provider 设置提示；运行禁用 |
| 自动选择淘汰全部源 | 展示排除原因；运行禁用 |
| 旧模式缺模型 | 阻断提示；不显示“自动降级” |
| 新策略缺可选模型 | warning + 降级说明；允许运行 |
| 用户取消 | 立即停止本地追加，调用已知 taskId 取消并 abort；终态显示“已取消”，保留临时结果并标记非最终 |
| 重复取消 | 按钮禁用；终态后隐藏 loading，不重复请求 |
| HTTP 4xx | 展示 code/message/details；不得改成成功或 500 |
| 流内 error | 终止连接、保留已有临时结果、显示最终错误区；无最终成功徽章 |
| completed 但 0 结果 | “搜索成功但没有结果”，与失败区分 |
| 全部 Provider 失败 | “所有来源均失败”，展示 failedSources 与重试 |
| partial | 成功结果 + 明确“部分来源失败”徽章 |
| 无重排对比/无 debug | 对应卡片隐藏或显示无数据说明，不用骨架假装加载 |

取消时序：若 `meta` 已给出 taskId，先调用取消 API，再 abort 本地流；若尚未拿到 taskId，只 abort 本地流。无论顺序，收到 cancelled 终态后停止 loading。

## 12. 移动端窄屏

- 断点 `<768px` 左右栏改为单列，查询控制在前，结果在后。
- 所有按钮最小点击区域 44×44px；主要操作不全靠图标。
- Provider 列表最大高度可滚动，选中计数固定可见。
- 表格使用容器横向滚动，首列 sticky；页面本身不得产生横向滚动。
- 结果标题至少两行，URL 可换行或截断 with title；hover 才显示的操作在触屏常显。
- 重排对比由双列改为上下两区；位移徽章紧随文档标题。
- 正文 Drawer 在窄屏为全屏，支持 Esc、关闭按钮、焦点圈定和返回焦点。
- 360px 宽度下无溢出、无重叠；进度、徽章、错误详情均可读。

## 13. 组件级改动位置

### 13.1 `apps/web/src/pages/lab.tsx`

拆分为页面内组件或同目录组件：

- `StrategyModePicker`：策略/旧模式单选，构造互斥请求。
- `ProviderSelector`：自动/手动、资格原因、选中数量。
- `RunProgress`：阶段、Provider 状态、确定/不定进度、取消。
- `RouteSummary`：`route.selected/ruleId/matchedSignals/considered`。
- `QueryExpansionList`：原查询、扩展、Deep 预算与 `queryOrigins`。
- `SourceContribution`：逐源贡献条与表格。
- `RankingComparison`：重排前后与位移。
- `ResultRow`：最终/临时样式、正文入口、来源贡献。
- `ReaderDrawer`：按需正文读取与错误状态。

建议使用 reducer 管理 `idle/running/completed/partial/failed/cancelled` 和 `provisionalResults/finalResponse`，避免多个 useState 造成终态竞争。

### 13.2 `apps/web/src/lib/types.ts`

新增：

```ts
type SearchStrategy = "auto" | "fast" | "balanced" | "quality" | "deep";
type SearchStreamFormat = "sse" | "ndjson";
interface RouteExplanation { selected: SearchStrategy; ruleId: string; matchedSignals: string[]; considered: SearchStrategy[]; }
interface Degradation { stage: string; reason: string; fallback: string; }
interface FunnelStats { /* PRD B1 字段 */ }
interface QueryOrigin { /* PRD B3 字段 */ }
interface RerankComparison { before: SearchResult[]; after: SearchResult[]; movements: unknown[]; }
interface WebReadResponse { url: string; title?: string; text?: string; readStatus: string; truncated: boolean; extractor?: string; }
type SearchStreamEvent = /* meta/status/results/done/error */;
```

扩展 `SearchRequest`：`mode?`、`strategy?`、`queryExpansion?`、`maxSubqueries?`、`maxRounds?`、`stream?`。扩展 `SearchResponse`：`strategy?`、`route?`、`degradations?`、`stats.funnel?`、`stats.cacheState?`、`debug.queryOrigins?/rerankComparison?`。

### 13.3 `apps/web/src/lib/api.ts`

新增：

- `searchStream(body, {format, signal, onEvent})`：处理 SSE/NDJSON、CSRF、content-type、分块、心跳、终态后关闭 reader、abort reader。
- `readWebpage(body, signal)`：调用统一正文读取。
- `previewSearchRoute(body, signal)`：P1，可选的运行前路由预览；不得调用上游搜索。

保留 `api.search()` 供旧模式和非流式回退使用。

### 13.4 `apps/web/src/lib/search-response.ts`

- 增加临时结果按 `id/normalizedUrl` 合并、最终快照规范化、raw 移除复用。
- 复制/下载只允许 `finalResponse`；临时结果导出需显式命名 `provisional`，默认入口不提供。
- 不得在规范化中排序最终 `results`。

### 13.5 i18n 与基础组件

- `lib/i18n.ts`、`i18n-zh.ts`、`i18n-en.ts` 增加 `lab.strategy.*`、`lab.route.*`、`lab.stream.*`、`lab.expansion.*`、`lab.contribution.*`、`lab.compare.*`、`lab.reader.*`、`lab.cache.*`、`lab.funnel.*`。
- 中英文键集合必须一致；数字、复数、插值纳入检查。
- 优先用现有 `Card/Alert/Badge/Button/Collapsible/EmptyState/Skeleton`。若增加 Drawer/Progress，放在 `components/ui.tsx` 且只实现通用能力，不在页面复制多套焦点管理。

### 13.6 不需要改动

- `App.tsx`：不新增 route。
- `components/app-shell.tsx`：不新增导航。
- 不新增设置页、Provider 页或独立正文页。

## 14. 可测试验收条件

| ID | 优先级 | 验收条件 |
|---|---|---|
| LAB-01 | P0 | 策略与旧 mode 选择互斥；四种预设及 Auto 可见；旧模式 10 个值全部保留 |
| LAB-02 | P0 | 不传参数时 Lab 仍发送当前默认 `mode=rrf`；不会误发 `strategy` |
| LAB-03 | P0 | 自动 Provider 模式不发送 providers；meta 返回后展示权威 selectedProviderIds 与排除原因 |
| LAB-04 | P0 | 手动模式 0 Provider 阻止运行；自动模式全部不可用时展示明确空态 |
| LAB-05 | P0 | 新策略使用真 SSE/NDJSON；分块、心跳、abort、流内 error 均有测试 |
| LAB-06 | P0 | 临时结果有虚线/“临时”徽章；done 后原子替换为“最终”，无重复卡片 |
| LAB-07 | P0 | 复制/下载最终 JSON 不含临时事件、sequence、raw；最终 results 顺序不被规范化改变 |
| LAB-08 | P0 | 取消后显示 cancelled 终态，保留临时结果并标“非最终”；不显示最终成功徽章 |
| LAB-09 | P0 | 无确定 total 时不显示百分比；心跳不改变阶段或进度 |
| LAB-10 | P0 | 扩展默认关闭；最多展示 3 个扩展查询；原查询始终保留；无模型时显示降级且仍可运行 |
| LAB-11 | P0 | Deep 展示子查询/轮次/Provider-query/HTTP 四项预算和预算耗尽状态 |
| LAB-12 | P0 | 来源贡献数量与最终 sources 聚合一致；明确标注“频次不代表相关性” |
| LAB-13 | P0 | 有 rerankComparison 时正确显示 ↑/↓/新进入/移出；单侧名次为“—” |
| LAB-14 | P0 | 无 Rerank 或无对比数据时不伪造重排前排名 |
| LAB-15 | P0 | “查看正文”按需请求；打开 10 条结果不会自动产生 10 次正文请求 |
| LAB-16 | P0 | 正文读取默认 render=false；普通文章不启动 Chromium；原始 HTML 不渲染 |
| LAB-17 | P0 | soft404/login/captcha/maintenance/超时/截断在 Drawer 中有不同状态与文案 |
| LAB-18 | P0 | 绕过缓存、命中、未命中、未知四种缓存状态可区分，不把未知写为 0 |
| LAB-19 | P0 | 延迟展示服务端与客户端耗时；单次运行不伪造 P95 |
| LAB-20 | P0 | 候选漏斗展示 B1 恒等式；不一致时显示 warning 而非修正数据 |
| LAB-21 | P0 | completed 空结果、partial、全部失败、HTTP 4xx、流内 error 状态各不相同 |
| LAB-22 | P0 | 旧 rerank 模式缺模型时阻断/400；新 Quality 缺模型时允许降级，两者不混淆 |
| LAB-23 | P0 | 360px 与 768px 视口无页面横向溢出；表格容器可滚动；Drawer 全屏可关闭 |
| LAB-24 | P0 | 键盘可完成策略选择、运行、取消、打开/关闭正文；Esc 关闭 Drawer 并返回焦点 |
| LAB-25 | P0 | 中英文 lab 键集合一致；状态不只靠颜色区分 |
| LAB-26 | P0 | `/lab` 路由与导航数量不变；不新增无关页面 |
| LAB-27 | P1 | route-preview 可用时防抖调用且不触发上游搜索；失败不阻塞手动运行 |
| LAB-28 | P1 | 同一 URL 在页面会话内重复打开可复用结果；关闭 Drawer 取消未完成请求 |

建议测试落点：组件/状态测试覆盖 LAB-01–14、18–22、24–25；Playwright `tests/e2e/v0118-lab.spec.ts` 覆盖流式、正文按需、取消、窄屏和无新路由；契约测试覆盖 `types.ts` 与 `api.ts` 的 SSE/NDJSON 解析。
