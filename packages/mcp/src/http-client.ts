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

export class HttpWebpageService implements McpWebpageService {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async read(url: string, options: { maxContentChars?: number } = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/web/read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ url, ...options }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    // 422 is a successful fetch with a classified, unusable page. Preserve its
    // structured result so the MCP tool can report readStatus/reasonCode.
    if (response.ok || response.status === 422) return body;
    throw new SearchHubError("server_error", "Webpage reading is unavailable on this Search Hub server");
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
