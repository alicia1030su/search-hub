import {
  ProviderError,
  getByPath,
  isPlainObject,
  renderTemplate,
  setByPath,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";

export const GENERIC_METHODS = ["GET", "POST"] as const;
export const GENERIC_KEY_INJECTION_LOCATIONS = ["header", "query", "body"] as const;

export interface GenericProviderConfig {
  method?: "GET" | "POST";
  /** Relative path appended to baseUrl, e.g. "/api/search". */
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  keyInjection?: {
    in: "header" | "query" | "body";
    /** Header name, query parameter name, or dotted body path. */
    name: string;
    prefix?: string;
  };
  /** Dotted path to the results array. Defaults to "results". */
  resultsPath?: string;
  mapping?: {
    title?: string;
    url?: string;
    snippet?: string;
    publishedAt?: string;
    score?: string;
    language?: string;
  };
  timeoutMs?: number;
}

// Safe dotted paths only: letters, digits, underscore, dash, dot, brackets.
// eslint-disable-next-line no-useless-escape
const PATH_PATTERN = /^[A-Za-z0-9_\-.\[\]]{1,120}$/;

function isSafePath(path: string): boolean {
  return PATH_PATTERN.test(path) && !path.includes("..");
}

function containsKeyTemplate(value: unknown): boolean {
  if (typeof value === "string") return /\{\{\s*key\s*\}\}/.test(value);
  if (Array.isArray(value)) return value.some(containsKeyTemplate);
  if (isPlainObject(value)) return Object.values(value).some(containsKeyTemplate);
  return false;
}

/** generic-http 是否实际消费凭据：显式注入或任一请求模板引用 {{key}}。 */
export function genericProviderRequiresKey(config: Record<string, unknown>): boolean {
  if (!isPlainObject(config)) return false;
  if (config["keyInjection"]) return true;
  return ["headers", "query", "body"].some((field) => containsKeyTemplate(config[field]));
}

export function validateGenericConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (config === undefined || config === null) return errors;
  if (!isPlainObject(config)) return ["config must be an object"];
  const cfg = config as GenericProviderConfig;

  if (cfg.method && !GENERIC_METHODS.includes(cfg.method)) {
    errors.push(`method must be one of ${GENERIC_METHODS.join(", ")}`);
  }
  if (cfg.path !== undefined && (typeof cfg.path !== "string" || !cfg.path.startsWith("/"))) {
    errors.push("path must be a string starting with /");
  }
  for (const field of ["headers", "query"] as const) {
    const value = cfg[field];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      errors.push(`${field} must be an object of string values`);
      continue;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") errors.push(`${field}.${key} must be a string`);
    }
  }
  if (cfg.keyInjection) {
    if (!GENERIC_KEY_INJECTION_LOCATIONS.includes(cfg.keyInjection.in)) {
      errors.push("keyInjection.in must be header, query or body");
    }
    if (!cfg.keyInjection.name || typeof cfg.keyInjection.name !== "string") {
      errors.push("keyInjection.name is required");
    } else if (cfg.keyInjection.in === "body" && !isSafePath(cfg.keyInjection.name)) {
      errors.push("keyInjection.name must be a safe dotted path");
    }
  }
  if (cfg.resultsPath && !isSafePath(cfg.resultsPath)) {
    errors.push("resultsPath must be a safe dotted path");
  }
  if (cfg.mapping) {
    for (const [key, value] of Object.entries(cfg.mapping)) {
      if (typeof value !== "string" || !value) {
        errors.push(`mapping.${key} must be a non-empty string`);
      } else if (!isSafePath(value)) {
        errors.push(`mapping.${key} must be a safe dotted path`);
      }
    }
  }
  return errors;
}

function renderDeep(value: unknown, vars: Record<string, string | number | undefined>): unknown {
  if (typeof value === "string") return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars));
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = renderDeep(entry, vars);
    }
    return output;
  }
  return value;
}

/**
 * Declarative HTTP/JSON provider. Users describe the request and the response
 * field mapping in the UI; no user-supplied code is executed.
 */
export const genericHttpAdapter: SearchProviderAdapter = {
  type: "generic-http",
  requiresKey: false,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    const cfg = (ctx.config.config ?? {}) as GenericProviderConfig;
    const errors = validateGenericConfig(cfg);
    if (errors.length > 0) {
      throw new ProviderError(
        ctx.config.id,
        "generic-http",
        "bad_request",
        `Invalid generic provider config: ${errors.join("; ")}`,
      );
    }
    if (!ctx.config.baseUrl) {
      throw new ProviderError(
        ctx.config.id,
        "generic-http",
        "bad_request",
        "Generic HTTP provider requires a base URL",
      );
    }

    const method = cfg.method ?? "GET";
    const url = new URL(cfg.path ?? "", ctx.config.baseUrl.endsWith("/") ? ctx.config.baseUrl : `${ctx.config.baseUrl}/`);

    const vars = {
      query: input.query,
      key: ctx.apiKey ?? "",
      limit: input.limit,
      language: input.language ?? ctx.config.language ?? "",
      freshness: input.freshness ?? "all",
      page: 1,
    } satisfies Record<string, string | number>;

    for (const [key, template] of Object.entries(cfg.query ?? {})) {
      url.searchParams.set(key, renderTemplate(template, vars));
    }

    const headers: Record<string, string> = {};
    for (const [key, template] of Object.entries(cfg.headers ?? {})) {
      headers[key] = renderTemplate(template, vars);
    }

    const needsKey = genericProviderRequiresKey(ctx.config.config ?? {});
    if (needsKey && !ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "generic-http",
        "auth_invalid",
        "This provider requires an API key but none is available",
      );
    }

    if (cfg.keyInjection && ctx.apiKey) {
      const injected = `${cfg.keyInjection.prefix ?? ""}${ctx.apiKey}`;
      if (cfg.keyInjection.in === "header") headers[cfg.keyInjection.name] = injected;
      if (cfg.keyInjection.in === "query") url.searchParams.set(cfg.keyInjection.name, injected);
    }

    let body: unknown;
    if (cfg.body !== undefined) {
      body = renderDeep(cfg.body, vars) as Record<string, unknown>;
      if (cfg.keyInjection?.in === "body" && ctx.apiKey && isPlainObject(body)) {
        setByPath(body, cfg.keyInjection.name, `${cfg.keyInjection.prefix ?? ""}${ctx.apiKey}`);
      }
    } else if (cfg.keyInjection?.in === "body" && ctx.apiKey) {
      body = {};
      setByPath(body as Record<string, unknown>, cfg.keyInjection.name, `${cfg.keyInjection.prefix ?? ""}${ctx.apiKey}`);
    }

    const response = await callJson(ctx, {
      url: url.toString(),
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
    });

    const resultsPath = cfg.resultsPath ?? "results";
    let items: unknown = getByPath(response.data, resultsPath);
    if (items === undefined && resultsPath === "results" && Array.isArray(response.data)) {
      // Some APIs return a bare array.
      items = response.data;
    }
    if (!Array.isArray(items)) {
      throw new ProviderError(
        ctx.config.id,
        "generic-http",
        "bad_request",
        `resultsPath "${resultsPath}" did not resolve to an array. ` +
          "Check the response shape in the provider documentation and update the mapping.",
      );
    }

    const mapping = cfg.mapping ?? {};
    const results = items
      .map((item) =>
        mapItem(item, {
          titlePaths: [mapping.title ?? "title"],
          urlPaths: [mapping.url ?? "url"],
          snippetPaths: [mapping.snippet ?? "snippet", "description", "content"],
          publishedPaths: [mapping.publishedAt ?? "publishedAt", "published_at", "date"],
          scorePaths: [mapping.score ?? "score"],
          languagePaths: [mapping.language ?? "language"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (genericProviderRequiresKey(ctx.config.config ?? {})) {
      throw new ProviderError(
        ctx.config.id,
        "generic-http",
        "unsupported",
        "Credentialed generic providers require a search probe; a connectivity test cannot safely verify them.",
      );
    }
    const started = Date.now();
    const { results } = await genericHttpAdapter.search(
      { query: "test", limit: 1, signal: ctx.signal },
      ctx,
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      resultCount: results.length,
      message: `Generic provider returned ${results.length} result(s)`,
      sample: results.slice(0, 1).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
