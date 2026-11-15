import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { genericMcpAdapter } from "./generic-mcp.js";

/**
 * 秘塔搜索 MCP —— 兼容模式。
 *
 * 已有部署把秘塔搜索包装成了 MCP 服务（`server.py`，本地端口 44454，
 * `POST http://127.0.0.1:44454/mcp`）。这个适配器不改动、也不探测那台服务：
 * 它只是把 Generic MCP 的配置按秘塔的约定预置好，由管理员填写真实地址后使用。
 *
 * 预置项：
 * - 端点：`http://127.0.0.1:44454/mcp`（可用任意远程地址覆盖）
 * - 工具名：留空自动发现（该服务通常暴露 `metaso_search` / `search`）
 * - 参数模板：`{"q":"{{query}}","size":{{limit}}}`，因为秘塔系工具用 `q` 而不是 `query`
 * - 结果路径与字段：`webpages[]` / `title` / `link` / `snippet`
 *
 * Verification: `documented`。仅依据已部署服务的公开线索，未连接任何旧实例。
 */
export const metasoMcpAdapter: SearchProviderAdapter = {
  type: "metaso-mcp",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    // `genericMcpAdapter.search` is always defined; the optional marker on the
    // interface is the only reason TypeScript complains.
    if (!genericMcpAdapter.search) throw new Error("generic MCP search is unavailable");
    return genericMcpAdapter.search(input, withPreset(ctx));
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!genericMcpAdapter.test) throw new Error("generic MCP test is unavailable");
    return genericMcpAdapter.test(withPreset(ctx));
  },
};

const PRESET: Record<string, unknown> = {
  argumentsTemplate: '{"q":"{{query}}","size":{{limit}}}',
  resultsPath: "webpages",
  titleField: "title",
  urlField: "link",
  snippetField: "snippet",
  publishedField: "date",
};

/**
 * Fills in the 秘塔 defaults without overwriting anything the administrator
 * configured: an explicit value always wins over the preset.
 */
function withPreset(ctx: ProviderContext): ProviderContext {
  const config: Record<string, unknown> = { ...PRESET, ...ctx.config.config };
  return {
    ...ctx,
    config: {
      ...ctx.config,
      baseUrl: ctx.config.baseUrl ?? "http://127.0.0.1:44454/mcp",
      config,
    },
  };
}
