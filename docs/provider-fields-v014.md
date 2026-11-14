# v0.1.4 Provider 配置能力矩阵

日期：2026-11-15 ｜ 状态：**代码与契约测试完成，真实联调待凭证**

> 判定口径：`documented` = 按官方文档实现且有本地契约测试；`live_tested` = 有真实调用记录。
> 本轮**没有任何 Provider 升到 `live_tested`**，因为没有任何真实凭证。

## 第一批：原生搜索 Provider（已实现）

| Type | 官方文档 | 真实端点 | 鉴权 | Web 表单字段 | 可无 Key | 状态 |
|---|---|---|---|---|---|---|
| `tencent-yuanbao` | [腾讯云 SearchPro](https://cloud.tencent.com/document/product/1806/121811) | `POST https://wsa.tencentcloudapi.com/` | TC3-HMAC-SHA256，SecretId + SecretKey | SecretId、SecretKey、搜索模式、垂直领域、站点过滤 | 否 | documented |
| `doubao` | [火山联网搜索](https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh) | `POST https://open.feedcoopapi.com/search_api/web_search` | Bearer | 限定站点、屏蔽站点、Query 改写 | 否 | documented |
| `deepseek-search` | [DeepSeek Search](https://api-docs.deepseek.com/zh-cn/guides/search/) | `POST https://api.deepseek.com/v1/tools/search` | Bearer | 返回正文开关 | 否 | documented |
| `qianfan-search` | [百度千帆 AI 搜索](https://cloud.baidu.com/doc/qianfan-api/s/Jmwbl4qxs) | `POST https://qianfan.baidubce.com/v2/ai_search/web_search` | Bearer | 版本（standard/turbo/pro）、限定站点 | 否 | documented |
| `anysearch` | [anysearch-skill](https://github.com/anysearch-ai/anysearch-skill) | `POST https://api.anysearch.com/v1/search` | 可选 Bearer | 垂直标签、区域偏好 | **是**（匿名限流更严） | documented |

### 各 Provider 的协议要点（已核对）

- **腾讯元宝**：`Response.Pages` 是 **JSON 字符串数组**，需二次解析；`Cnt` 只接受 10/20/30/40/50；`Freshness` 用 `dN/mN/yN` 或日期区间。凭证是**一对**，存为一个 JSON 字符串整体轮换。
- **豆包**：字段全部 **PascalCase**；`Result` 失败时为 `null`，错误在 `ResponseMetadata.Error`；10406/10408/10409/10410/10412 是额度问题。
- **DeepSeek**：独立 Search API，不是 Chat Completion；402 是余额不足。
- **千帆**：真实网页在 `references[]`，图片类型会被过滤；`messages` 仅单轮。
- **AnySearch**：`{code,data:{results[]}}`，`code !== 0` 即失败；匿名与带 Key 的限流不同。

## 第二批：AI 联网 Provider（**未实现**）

| Type | 计划协议 | 本轮状态 |
|---|---|---|
| `gemini` | Google Search Grounding，`groundingMetadata` 引用 | 未实现（文档站点在本机不可达） |
| `grok` | xAI Responses API + `web_search` 工具 | 未实现（端点在本机不可达） |
| `mimo` | `POST /v1/chat/completions` + `web_search` 工具 | 未实现 |
| `bailian` | Chat Completions `enable_search` | 未实现 |
| `minimax` | 官方 web_search MCP | 未实现（需 stdio/uvx 信任模型） |
| `stepfun` | 官方联网接口未证实 | 未实现 |

这些在目录里保持 `planned`，**不能创建**；需要网关时可先用 `generic-http` 并标注实际协议。

## 第三批：兼容网关与长尾

| 类型 | 建议接入方式 | 状态 |
|---|---|---|
| DuckDuckGo | 无官方通用 API；仅 Instant Answer | 不可创建 |
| 秘塔 | 官方页面仅有 `POST /api/v1/search` 与 q/scope/size/page，host/鉴权/响应未核实 | 不可创建 |
| Search Gateway / 其他自建网关 | `generic-http` 声明式映射 | 可用 |
| Generic MCP | 远程 Streamable HTTP（计划） | **未实现** |

## 能力分离

- `raw_search`：返回可验证网页结果（第一批全部属于此类）。
- `grounded_answer`：返回模型回答 + `citations[]` + `toolInvoked`。**本轮无此类 Provider 实现**，但契约、REST/MCP 通道与实验台展示已就绪。

## 凭证安全

- 所有凭证经现有 Key Scheduler 加密存储，界面只显示首 4 + 末 4。
- 腾讯凭证对以一个 JSON 字符串存储，轮换原子化，禁止两个字段独立组合。
- 测试失败信息经过 `redactSecrets`，不包含明文。
