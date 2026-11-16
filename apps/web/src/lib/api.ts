import type {
  AccessTokenSummary,
  ApiKeySummary,
  AppSettings,
  AuditLog,
  AuthSession,
  DashboardStats,
  GenericProviderConfig,
  GroupInput,
  HealthStatus,
  KeyInput,
  LogEvent,
  McpInfo,
  ModelConfig,
  ModelInput,
  ModelTestResult,
  ProviderInput,
  ProviderRuntimeSnapshot,
  ProviderSummary,
  ProviderTestResult,
  ProvidersResponse,
  SearchGroup,
  SearchRequest,
  SearchResponse,
  SearchTaskRecord,
  SetupInput,
  SetupStatus,
  SkillEntry,
  TokenCreateResult,
  HealthOverview,
  HealthCheckResult,
  McpStatus,
  McpUpdateCheck,
  SkillSummary,
  UpdateStatusResponse,
} from "./types";

const API_PREFIX = "/api";

let csrfToken: string | null = null;
let csrfPromise: Promise<string | null> | null = null;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isAbortError(error)) return new ApiError(0, "aborted", "Request aborted");
  if (error instanceof Error) return new ApiError(0, "network_error", error.message);
  return new ApiError(0, "network_error", String(error));
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Fetches /api/auth/session to (re)fill the CSRF cache. Returns null when the
 * browser is not signed in. Network failures are swallowed: the caller's own
 * request will surface the real error.
 */
export async function ensureCsrf(force = false): Promise<string | null> {
  if (csrfToken && !force) return csrfToken;
  if (csrfPromise) return csrfPromise;
  csrfPromise = (async () => {
    try {
      const response = await fetch(`${API_PREFIX}/auth/session`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as AuthSession;
      csrfToken = data.csrfToken;
      return csrfToken;
    } catch {
      return null;
    } finally {
      csrfPromise = null;
    }
  })();
  return csrfPromise;
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent("sh:unauthorized"));
}

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  allowUnauthorized?: boolean;
  /** Internal: prevents an infinite CSRF retry loop. */
  csrfRetry?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return `${API_PREFIX}${path}${suffix ? `?${suffix}` : ""}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractError(data: unknown, status: number): ApiError {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error;
    if (error && typeof error.code === "string") {
      return new ApiError(
        status,
        error.code,
        typeof error.message === "string" ? error.message : `HTTP ${status}`,
        error.details,
      );
    }
  }
  return new ApiError(
    status,
    `http_${status}`,
    typeof data === "string" && data.trim() ? data.slice(0, 300) : `HTTP ${status}`,
  );
}

export async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["Content-Type"] = "application/json";

  if (method !== "GET") {
    if (!csrfToken) await ensureCsrf();
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      credentials: "include",
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    throw toApiError(error);
  }

  const data = await readJson(response);

  if (!response.ok) {
    const error = extractError(data, response.status);
    if (response.status === 401 && !options.allowUnauthorized) notifyUnauthorized();
    if (
      response.status === 403 &&
      method !== "GET" &&
      options.csrfRetry !== false &&
      /csrf/i.test(error.message)
    ) {
      csrfToken = null;
      const refreshed = await ensureCsrf(true);
      if (refreshed) {
        return request<T>(path, { ...options, csrfRetry: false });
      }
    }
    throw error;
  }

  return data as T;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export const api = {
  // ---- setup & auth ----
  setupStatus: (signal?: AbortSignal) =>
    request<SetupStatus>("/setup/status", { signal }),
  setup: (input: SetupInput) =>
    request<AuthSession>("/setup", { method: "POST", body: input }),
  login: (input: { email: string; password: string }) =>
    request<AuthSession>("/auth/login", { method: "POST", body: input }),
  session: (signal?: AbortSignal) =>
    request<AuthSession>("/auth/session", { signal, allowUnauthorized: true }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  health: (signal?: AbortSignal) => request<HealthStatus>("/health", { signal }),

  // ---- search ----
  search: (body: SearchRequest, signal?: AbortSignal) =>
    request<SearchResponse>(body.mode === "deep" ? "/search/deep" : "/search", {
      method: "POST",
      body,
      signal,
    }),
  searchTask: (id: string, signal?: AbortSignal) =>
    request<SearchTaskRecord>(`/search/tasks/${seg(id)}`, { signal }),
  cancelSearchTask: (id: string) =>
    request<{ ok: boolean; taskId?: string }>(`/search/tasks/${seg(id)}/cancel`, {
      method: "POST",
    }),

  // ---- providers ----
  providers: (signal?: AbortSignal) =>
    request<ProvidersResponse>("/admin/providers", { signal }),
  createProvider: (input: ProviderInput) =>
    request<{ provider?: ProviderSummary }>("/admin/providers", {
      method: "POST",
      body: input,
    }),
  updateProvider: (id: string, input: Partial<ProviderInput>) =>
    request<{ provider?: ProviderSummary }>(`/admin/providers/${seg(id)}`, {
      method: "PATCH",
      body: input,
    }),
  batchCreateProviders: (items: Array<{ type: string; name?: string }>) =>
    request<{ created: Array<{ id: string; type: string; name: string; enabled: boolean }>; skipped: Array<{ type: string; reason: string }> }>(
      "/admin/providers/batch",
      { method: "POST", body: { items } },
    ),
  bulkProviders: (action: "install_all" | "enable_ready" | "disable_all", acceptCost = false) =>
    request<{ changed: Array<{ id: string; name: string; action: string }>; skipped: Array<{ name: string; reason: string }> }>(
      "/admin/providers/bulk",
      { method: "POST", body: { action, acceptCost } },
    ),
  batchSetProviders: (ids: string[], enabled: boolean) =>
    request<{ changed: Array<{ id: string; enabled: boolean }>; skipped: Array<{ id: string; name: string; reason: string }> }>(
      "/admin/providers/batch-state",
      { method: "POST", body: { ids, enabled } },
    ),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/admin/providers/${seg(id)}`, { method: "DELETE" }),
  testProvider: (id: string, keyId?: string) =>
    request<ProviderTestResult>(`/admin/providers/${seg(id)}/test`, {
      method: "POST",
      body: keyId ? { keyId } : {},
    }),
  providerStatus: (id: string, signal?: AbortSignal) =>
    request<ProviderRuntimeSnapshot>(`/admin/providers/${seg(id)}/status`, { signal }),
  validateGeneric: (config: GenericProviderConfig) =>
    request<{ valid: boolean; errors: string[] }>("/admin/providers/validate-generic", {
      method: "POST",
      body: { config },
    }),

  // ---- provider health ----
  healthOverview: (signal?: AbortSignal) =>
    request<HealthOverview>("/admin/health", { signal }),
  healthCheck: (input: { providerId?: string; providerIds?: string[]; kind?: "connect" | "search" }) =>
    request<{ results: HealthCheckResult[]; skipped: Array<{ providerId: string; reason: string }> }>(
      "/admin/health/check",
      { method: "POST", body: { kind: "connect", ...input } },
    ),
  healthHistory: (providerId: string, signal?: AbortSignal) =>
    request<{ checks: HealthCheckResult[] }>(`/admin/health/history?providerId=${seg(providerId)}`, {
      signal,
    }),

  // ---- MCP / skills / updates ----
  mcpStatus: (signal?: AbortSignal) => request<McpStatus>("/admin/mcp", { signal }),
  mcpUpdateCheck: () =>
    request<McpUpdateCheck>("/admin/mcp/update-check", { method: "POST", body: { force: true } }),
  updateStatus: (signal?: AbortSignal) =>
    request<UpdateStatusResponse>("/admin/update", { signal }),

  // ---- keys ----
  providerKeys: (providerId: string, signal?: AbortSignal) =>
    request<ApiKeySummary[]>(`/admin/providers/${seg(providerId)}/keys`, { signal }),
  createKey: (providerId: string, input: KeyInput & { key: string }) =>
    request<ApiKeySummary>(`/admin/providers/${seg(providerId)}/keys`, {
      method: "POST",
      body: input,
    }),
  updateKey: (keyId: string, input: Partial<KeyInput>) =>
    request<ApiKeySummary>(`/admin/keys/${seg(keyId)}`, { method: "PATCH", body: input }),
  deleteKey: (keyId: string) =>
    request<{ ok: boolean }>(`/admin/keys/${seg(keyId)}`, { method: "DELETE" }),
  testKey: (keyId: string) =>
    request<ProviderTestResult>(`/admin/keys/${seg(keyId)}/test`, { method: "POST" }),

  // ---- groups ----
  groups: (signal?: AbortSignal) => request<SearchGroup[]>("/admin/groups", { signal }),
  createGroup: (input: GroupInput) =>
    request<SearchGroup>("/admin/groups", { method: "POST", body: input }),
  updateGroup: (id: string, input: Partial<GroupInput>) =>
    request<{ ok: boolean }>(`/admin/groups/${seg(id)}`, { method: "PATCH", body: input }),
  deleteGroup: (id: string) =>
    request<{ ok: boolean }>(`/admin/groups/${seg(id)}`, { method: "DELETE" }),

  // ---- models ----
  models: (signal?: AbortSignal) =>
    request<ModelConfig[]>("/admin/models", { signal }),
  createModel: (input: ModelInput) =>
    request<ModelConfig>("/admin/models", { method: "POST", body: input }),
  updateModel: (id: string, input: Partial<ModelInput>) =>
    request<ModelConfig>(`/admin/models/${seg(id)}`, { method: "PATCH", body: input }),
  deleteModel: (id: string) =>
    request<{ ok: boolean }>(`/admin/models/${seg(id)}`, { method: "DELETE" }),
  testModel: (id: string) =>
    request<ModelTestResult>(`/admin/models/${seg(id)}/test`, { method: "POST" }),

  // ---- dashboard / settings ----
  dashboard: (range: string, signal?: AbortSignal) =>
    request<DashboardStats>("/admin/dashboard", { query: { range }, signal }),
  settings: (signal?: AbortSignal) =>
    request<AppSettings>("/admin/settings", { signal }),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>("/admin/settings", { method: "PUT", body: patch }),

  // ---- tokens ----
  tokens: (signal?: AbortSignal) =>
    request<AccessTokenSummary[]>("/admin/tokens", { signal }),
  createToken: (input: {
    name: string;
    scopes: string[];
    rateLimitPerMin: number;
    expiresAt?: string | null;
  }) => request<TokenCreateResult>("/admin/tokens", { method: "POST", body: input }),
  revokeToken: (id: string) =>
    request<{ ok: boolean }>(`/admin/tokens/${seg(id)}`, { method: "DELETE" }),

  // ---- observability ----
  logs: (params: { limit: number; offset: number }, signal?: AbortSignal) =>
    request<{ events: LogEvent[] }>("/admin/logs", { query: params, signal }),
  audit: (params: { limit: number }, signal?: AbortSignal) =>
    request<{ logs: AuditLog[] }>("/admin/audit", { query: params, signal }),

  // ---- integrations ----
  mcpInfo: (signal?: AbortSignal) => request<McpInfo>("/mcp/info", { signal }),
  skillsValidated: (signal?: AbortSignal) =>
    request<{ skills: SkillSummary[]; summary: { total: number; valid: number; invalid: number } }>(
      "/admin/skills",
      { signal },
    ),
  skillDetail: (name: string, signal?: AbortSignal) =>
    request<SkillSummary & { content: string | null }>(`/admin/skills/${seg(name)}`, { signal }),
  /** Legacy shape used by the integrations page: name + description + content. */
  skills: (signal?: AbortSignal) =>
    request<{ skills: SkillEntry[] }>("/admin/skills", { signal }),
  exportConfig: () => request<Record<string, unknown>>("/admin/config/export"),
  /** The API wraps imports as { config } (see admin-routes importHandler). */
  importConfig: (config: Record<string, unknown>) =>
    request<unknown>("/admin/config/import", { method: "POST", body: { config } }),
};
