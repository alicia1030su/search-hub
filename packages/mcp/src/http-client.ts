import type { ProviderInstance, ProviderRuntimeSnapshot, SearchRequest, SearchResponse } from "@search-hub/shared";
import { SearchHubError } from "@search-hub/shared";
import type { McpHealthSnapshot, McpProviderService, McpSearchService, McpWebpageService } from "./tools.js";

/**
 * stdio mode is a thin proxy over the REST API.
 * That guarantees one search implementation and one configuration source,
 * even when the MCP client runs in a different process or container.
 */
export class HttpSearchService implements McpSearchService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async execute(request: SearchRequest, options: { actor?: string } = {}): Promise<SearchResponse> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ ...request, ...(options.actor ? { actor: options.actor } : {}) }),
    });
    const body = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error?: { message?: string } }).error?.message ?? "Search failed")
          : `Search failed with HTTP ${response.status}`;
      throw new SearchHubError("server_error", message);
    }
    return body as SearchResponse;
  }
}

const WEBPAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const WEBPAGE_HTTP_TIMEOUT_MS = 20_000;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > WEBPAGE_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw new SearchHubError("network", "Webpage response exceeded the size limit", { status: 502 });
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WEBPAGE_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new SearchHubError("network", "Webpage response exceeded the size limit", { status: 502 });
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const text = chunks.join("");
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SearchHubError("network", "Webpage service returned invalid JSON", { status: 502 });
    }
  } finally {
    reader.releaseLock();
  }
}

export class HttpWebpageService implements McpWebpageService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = WEBPAGE_HTTP_TIMEOUT_MS,
  ) {}

  async read(url: string, options: { maxContentChars?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (options.signal?.aborted) throw new SearchHubError("cancelled", "Webpage request cancelled");
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException("Webpage request timed out", "TimeoutError")), this.timeoutMs);
    const signals = [timeoutController.signal];
    if (options.signal) signals.push(options.signal);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/web/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ url, maxContentChars: options.maxContentChars }),
        signal: AbortSignal.any(signals),
      });
      // 422 is a successful fetch with a classified, unusable page. Preserve its
      // structured result so the MCP tool can report readStatus/reasonCode.
      if (response.ok || response.status === 422) return await readBoundedJson(response);
      await response.body?.cancel();
      if (response.status === 401) throw new SearchHubError("unauthorized", "Webpage service authentication required");
      if (response.status === 403) throw new SearchHubError("forbidden", "Webpage service access denied");
      if (response.status === 404) throw new SearchHubError("not_found", "Webpage service endpoint is unavailable");
      if (response.status === 429) throw new SearchHubError("rate_limited", "Webpage service rate limit exceeded");
      if (response.status === 504) throw new SearchHubError("timeout", "Webpage service request timed out");
      throw new SearchHubError("server_error", "Webpage service request failed", { status: response.status >= 500 ? 502 : 400 });
    } catch (error) {
      if (error instanceof SearchHubError) throw error;
      if (timeoutController.signal.aborted) throw new SearchHubError("timeout", "Webpage service request timed out");
      if (options.signal?.aborted) throw new SearchHubError("cancelled", "Webpage request cancelled");
      throw new SearchHubError("network", "Cannot reach webpage service", { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HttpProviderService implements McpProviderService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async load(): Promise<{
    providers: Array<Pick<ProviderInstance, "id" | "name" | "type" | "enabled">>;
    status: ProviderRuntimeSnapshot[];
  }> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/providers`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new SearchHubError("unauthorized", "Failed to read provider status from the Search Hub API");
    }
    return (await response.json()) as {
      providers: Array<Pick<ProviderInstance, "id" | "name" | "type" | "enabled">>;
      status: ProviderRuntimeSnapshot[];
    };
  }

  async list(): Promise<Array<Pick<ProviderInstance, "id" | "name" | "type" | "enabled">>> {
    return (await this.load()).providers;
  }

  async status(): Promise<ProviderRuntimeSnapshot[]> {
    return (await this.load()).status;
  }
}

/**
 * Health reader for the stdio bridge.
 *
 * Calls the purpose-built `/api/mcp/health` projection, not `/api/admin/health`:
 * a stdio server is typically given a search-scope token, and a search token
 * must not be able to read the admin surface.
 */
export class HttpHealthService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async snapshot(): Promise<McpHealthSnapshot | null> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/mcp/health`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as McpHealthSnapshot;
    } catch {
      // A missing health endpoint must degrade the tool, not crash the server.
      return null;
    }
  }
}
