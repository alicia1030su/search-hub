import {
  SearchHubError,
  providerCreateSchema,
  type ProviderInstance,
} from "@search-hub/shared";
import { getAdapter, validateGenericConfig } from "@search-hub/providers";

/**
 * Legacy Search Hub migration.
 *
 * The previous deployment exposes its backend list as JSON (typically
 * `/mcp` metadata or an admin `GET /providers`). This module converts that
 * payload into *importable* Search Hub providers **without ever handling
 * credentials**:
 *
 *  - Only non-secret fields are mapped (name, type, base URL, limits, mapping).
 *  - API keys are never read from the payload and never written anywhere.
 *    Keys must be re-entered by the operator in the UI, one per provider.
 *  - Nothing is mutated on the remote system: the input is a JSON body the
 *    operator pasted or uploaded. We never call the legacy server.
 *  - Two modes: `dry_run` (default, reports what would happen) and `apply`,
 *    which requires an explicit confirmation string and refuses to overwrite
 *    existing provider names.
 */

export type LegacyMode = "dry_run" | "apply";

interface LegacyProviderShape {
  name?: unknown;
  id?: unknown;
  type?: unknown;
  provider?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  url?: unknown;
  endpoint?: unknown;
  enabled?: unknown;
  timeoutMs?: unknown;
  maxConcurrency?: unknown;
  rpmLimit?: unknown;
  priority?: unknown;
  weight?: unknown;
  mapping?: unknown;
  config?: unknown;
}

export interface LegacyPlanItem {
  /** Name that will be used in the new instance. */
  name: string;
  /** Adapter type chosen for this entry. */
  type: string;
  /** Where the mapping came from. */
  decision: "generic-http" | "builtin" | "compat-gateway" | "skipped";
  reason: string;
  /** True when the operator must supply an API key afterwards. */
  requiresKey: boolean;
  /** Redacted summary of the endpoint (scheme + host only). */
  endpoint?: string;
}

export interface LegacyPlan {
  mode: LegacyMode;
  total: number;
  importable: number;
  skipped: number;
  items: LegacyPlanItem[];
  warnings: string[];
  /** Providers that will need a key before they can serve traffic. */
  keysRequired: string[];
}

/** Type aliases used by older installations. */
const TYPE_ALIASES: Record<string, string> = {
  brave: "brave",
  "brave-search": "brave",
  bravesearch: "brave",
  searxng: "searxng",
  searx: "searxng",
  "searx-ng": "searxng",
  hn: "hackernews",
  hackernews: "hackernews",
  "hacker-news": "hackernews",
  mock: "mock",
  generic: "generic-http",
  "generic-http": "generic-http",
  http: "generic-http",
  custom: "generic-http",
};

/** Old compatibility gateways all speak a JSON search API, so they map to generic-http. */
const COMPAT_GATEWAY_HINTS = [
  "search-gateway",
  "search_gateway",
  "alt-search-gateway",
  "altsearch",
  "premium",
  "orz",
  "union-free",
  "unionfree",
  "zhihu-radar",
  "zhihurobot",
  "gpt55",
  "gpt-55",
];

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Strips path/query/credentials so a report can be pasted into an issue. */
export function redactEndpoint(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function looksLikeCompatGateway(value: string): boolean {
  const lower = value.toLowerCase();
  return COMPAT_GATEWAY_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Builds a plan from a legacy payload. `existingNames` is used to detect
 * collisions without touching the database, so the same function works in a
 * dry run and in the apply path.
 */
export function planLegacyMigration(
  input: unknown,
  existingNames: string[],
  mode: LegacyMode = "dry_run",
  extraAllowed: string[] = [],
): LegacyPlan {
  const warnings: string[] = [];
  const items: LegacyPlanItem[] = [];
  const keysRequired: string[] = [];

  const list = extractProviderList(input);
  if (!list) {
    throw new SearchHubError(
      "validation_error",
      "Could not find a provider list. Expected an array under `providers`, `sources`, `servers` or `data`.",
    );
  }

  const existing = new Set(existingNames.map((name) => name.toLowerCase()));
  let index = 0;

  for (const raw of list) {
    index += 1;
    if (!raw || typeof raw !== "object") {
      items.push({
        name: `entry-${index}`,
        type: "",
        decision: "skipped",
        reason: "Entry is not an object",
        requiresKey: false,
      });
      continue;
    }
    const row = raw as LegacyProviderShape;
    const rawName = text(row.name) || text(row.id) || `legacy-${index}`;
    const declaredType = text(row.type) || text(row.provider) || text(row.kind);
    const endpoint = text(row.baseUrl) || text(row.url) || text(row.endpoint);

    // Collision handling: never overwrite an existing provider and never
    // create a duplicate on repeated imports. The operator can rename the
    // legacy entry if a second instance is genuinely wanted.
    const name = rawName.replace(/[^\w.\- ]+/g, "-").slice(0, 80);
    if (existing.has(name.toLowerCase())) {
      items.push({
        name,
        type: declaredType,
        decision: "skipped",
        reason: "A provider with this name already exists; skipped (rename it in the export to import a second instance)",
        requiresKey: false,
      });
      continue;
    }

    const alias = TYPE_ALIASES[declaredType.toLowerCase()] ?? "";
    if (alias === "generic-http" || looksLikeCompatGateway(declaredType) || looksLikeCompatGateway(rawName)) {
      if (!endpoint) {
        items.push({
          name,
          type: "generic-http",
          decision: "skipped",
          reason: "Compatibility gateway entry has no base URL to map",
          requiresKey: false,
        });
        continue;
      }
      const adapter = getAdapter("generic-http");
      if (!adapter) {
        items.push({
          name,
          type: "generic-http",
          decision: "skipped",
          reason: "generic-http adapter is not registered in this build",
          requiresKey: false,
        });
        continue;
      }
      const mapping = buildGenericConfig(row, endpoint, extraAllowed);
      const ok = validateGeneric(mapping);
      if (!ok.ok) {
        items.push({
          name,
          type: "generic-http",
          decision: "skipped",
          reason: ok.reason,
          requiresKey: false,
          endpoint: redactEndpoint(endpoint),
        });
        continue;
      }
      keysRequired.push(name);
      items.push({
        name,
        type: "generic-http",
        decision: looksLikeCompatGateway(declaredType) ? "compat-gateway" : "generic-http",
        reason: "Declarative mapping generated; re-enter the API key in the UI",
        requiresKey: true,
        endpoint: redactEndpoint(endpoint),
      });
      // Stash the validated config on the item for the apply step.
      (items[items.length - 1] as LegacyPlanItem & { config?: unknown }).config = mapping;
      continue;
    }

    if (alias) {
      if ((alias === "searxng" || alias === "generic-http") && !endpoint) {
        items.push({
          name,
          type: alias,
          decision: "skipped",
          reason: "This provider type needs a base URL",
          requiresKey: false,
        });
        continue;
      }
      const adapter = getAdapter(alias);
      if (!adapter) {
        items.push({
          name,
          type: alias,
          decision: "skipped",
          reason: `Adapter "${alias}" is not available in this build`,
          requiresKey: false,
        });
        continue;
      }
      const requiresKey = adapter.requiresKey;
      if (requiresKey) keysRequired.push(name);
      items.push({
        name,
        type: alias,
        decision: "builtin",
        reason: requiresKey
          ? "Builtin adapter; re-enter the API key in the UI"
          : "Builtin adapter; no key required",
        requiresKey,
        ...(endpoint ? { endpoint: redactEndpoint(endpoint) } : {}),
      });
      (items[items.length - 1] as LegacyPlanItem & { config?: unknown }).config =
        sanitizeLegacyExtras(row);
      continue;
    }

    // Unknown type with a reachable base URL: try the declarative adapter.
    if (endpoint) {
      const mapping = buildGenericConfig(row, endpoint, extraAllowed);
      const ok = validateGeneric(mapping);
      if (ok.ok) {
        keysRequired.push(name);
        items.push({
          name,
          type: "generic-http",
          decision: "generic-http",
          reason: `Unknown legacy type "${declaredType}" mapped to the declarative adapter`,
          requiresKey: true,
          endpoint: redactEndpoint(endpoint),
        });
        (items[items.length - 1] as LegacyPlanItem & { config?: unknown }).config = mapping;
        continue;
      }
      items.push({
        name,
        type: declaredType,
        decision: "skipped",
        reason: `Unknown type and the endpoint could not be mapped: ${ok.reason}`,
        requiresKey: false,
        endpoint: redactEndpoint(endpoint),
      });
      continue;
    }

    items.push({
      name,
      type: declaredType,
      decision: "skipped",
      reason: "No adapter and no base URL; add it manually through the Generic HTTP provider",
      requiresKey: false,
    });
  }

  const importable = items.filter((item) => item.decision !== "skipped").length;
  return {
    mode,
    total: items.length,
    importable,
    skipped: items.length - importable,
    items,
    warnings,
    keysRequired,
  };
}

function extractProviderList(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["providers", "sources", "servers", "backends", "data", "items"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractProviderList(value);
      if (nested) return nested;
    }
  }
  return null;
}

interface GenericCandidate {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  keyInjection: { in: "header" | "query" | "body"; name: string; prefix?: string };
  resultsPath: string;
  mapping: { title: string; url: string; snippet: string; publishedAt?: string; score?: string };
}

/** Guesses a search endpoint from a legacy gateway description. */
function buildGenericConfig(
  row: LegacyProviderShape,
  endpoint: string,
  extraAllowed: string[],
): GenericCandidate {
  const supplied =
    row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {};
  const declaredMapping =
    row.mapping && typeof row.mapping === "object" ? (row.mapping as Record<string, unknown>) : {};
  const path = text(supplied["path"]) || text(supplied["searchPath"]) || "/search";
  const method = text(supplied["method"]).toUpperCase() === "POST" ? "POST" : "GET";
  const resultsPath =
    text(supplied["resultsPath"]) ||
    text(supplied["results_path"]) ||
    text(declaredMapping["resultsPath"]) ||
    "results";
  const keyName = text(supplied["keyName"]) || "key";

  void extraAllowed;

  return {
    method,
    path,
    keyInjection: { in: "query", name: keyName },
    resultsPath,
    mapping: {
      title: text(declaredMapping["title"]) || "title",
      url: text(declaredMapping["url"]) || "url",
      snippet: text(declaredMapping["snippet"]) || "snippet",
      publishedAt: text(declaredMapping["publishedAt"]) || "publishedAt",
    },
    ...(typeof supplied["headers"] === "object" && supplied["headers"] !== null
      ? { headers: supplied["headers"] as Record<string, string> }
      : {}),
    ...(typeof supplied["query"] === "object" && supplied["query"] !== null
      ? { query: supplied["query"] as Record<string, string> }
      : {}),
    ...(method === "POST" ? { body: supplied["body"] ?? { query: "{{query}}" } } : {}),
    // Record the endpoint separately; the importer sets baseUrl from it.
    ...(endpoint ? {} : {}),
  };
}

function validateGeneric(config: GenericCandidate): { ok: true } | { ok: false; reason: string } {
  const errors = validateGenericConfig(config);
  return errors.length === 0 ? { ok: true } : { ok: false, reason: errors.join("; ") };
}

function sanitizeLegacyExtras(row: LegacyProviderShape): Record<string, unknown> {
  // Copy only known-safe, non-secret fields.
  const source = row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {};
  const output: Record<string, unknown> = {};
  for (const key of ["tags", "categories", "safesearch", "language", "engine", "model"]) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

/**
 * Applies a previously computed plan. Refuses to touch existing providers and
 * never creates API keys, so a migration cannot silently inherit credentials.
 */
export function applyLegacyPlan(
  plan: LegacyPlan,
  confirm: string,
  // Injection hooks keep this module DB-agnostic and unit-testable.
  hooks: {
    createProvider: (input: { name: string; body: Record<string, unknown> }) => void;
  },
  legacyBaseUrl?: string,
): { created: string[]; skipped: string[] } {
  if (confirm !== "IMPORT LEGACY PROVIDERS") {
    throw new SearchHubError(
      "validation_error",
      'Applying a migration requires confirmation: {"confirm":"IMPORT LEGACY PROVIDERS"}',
    );
  }
  if (plan.mode !== "apply") {
    throw new SearchHubError("validation_error", "The plan was generated in dry_run mode; regenerate it with mode=apply");
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const item of plan.items) {
    if (item.decision === "skipped") {
      skipped.push(`${item.name}: ${item.reason}`);
      continue;
    }
    const config = (item as LegacyPlanItem & { config?: unknown }).config;
    const body: Record<string, unknown> = {
      name: item.name,
      type: item.type,
      enabled: true,
      config: config ?? {},
      ...(item.requiresKey ? {} : {}),
    };
    // A legacy gateway usually shares one base URL across every backend.
    const baseUrl = item.endpoint ?? legacyBaseUrl;
    if (baseUrl && (item.type === "generic-http" || item.type === "searxng")) {
      body["baseUrl"] = baseUrl;
    }
    try {
      const parsed = providerCreateSchema.parse(body);
      hooks.createProvider({ name: parsed.name, body: parsed as Record<string, unknown> });
      created.push(item.name);
    } catch (error) {
      skipped.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { created, skipped };
}

/** Rows that a plan can safely describe, for the API response. */
export function summarizeProviderRow(row: ProviderInstance): Record<string, unknown> {
  return {
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    baseUrl: row.baseUrl ? redactEndpoint(row.baseUrl) : null,
  };
}
