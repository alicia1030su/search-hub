import type { ProviderInstance, ProviderRuntimeSnapshot, SearchRequest, SearchResponse } from "@search-hub/shared";
import { SearchHubError } from "@search-hub/shared";
import type { McpProviderService, McpSearchService } from "./tools.js";

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
