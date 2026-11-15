import type {
  AccountQuotaCapability,
  PaginationCapability,
  ParameterLimit,
  ProviderCatalogEntry,
  ProviderManifest,
  ResolvedSearchConfig,
  ResultMappingSpec,
  SearchParameterKey,
} from "@search-hub/shared";

/**
 * Turns a catalog entry into a Provider Manifest.
 *
 * The manifest is the single source of truth for "what can this provider do":
 * the web UI renders its form from it, the API validates requests against it,
 * and the scheduler reads its pagination/quota capabilities. Nothing here can
 * execute code — it is pure data.
 *
 * Defaults are deliberately conservative: a provider that does not declare
 * pagination is treated as single-request, and one that does not declare
 * account scope is treated as per-key. Over-claiming would let the UI promise a
 * capability the adapter does not implement.
 */

const SINGLE_PAGE: PaginationCapability = { supported: false, mode: "none" };

const PER_KEY_QUOTA: AccountQuotaCapability = {
  scope: "key",
  sharedAcrossKeys: false,
};

const DEFAULT_MAPPING: ResultMappingSpec = {
  title: "title",
  url: "url",
  snippet: "snippet",
};

/** Platform parameters every provider can accept, because the platform supplies them. */
const BASELINE_PARAMETERS: SearchParameterKey[] = ["targetResults", "language", "freshness"];

const DEFAULT_LIMITS: Partial<Record<SearchParameterKey, ParameterLimit>> = {
  targetResults: { min: 1, max: 50, default: 10 },
};

export function buildManifest(entry: ProviderCatalogEntry): ProviderManifest {
  const supported = dedupe([...BASELINE_PARAMETERS, ...(entry.parameters ?? [])]);
  const pagination = entry.pagination ?? SINGLE_PAGE;
  const limits: Partial<Record<SearchParameterKey, ParameterLimit>> = {
    ...DEFAULT_LIMITS,
    ...entry.parameterLimits,
  };
  if (pagination.supported && pagination.pageSize !== undefined) {
    limits.targetResults = {
      ...limits.targetResults,
      max: pagination.maxResults ?? limits.targetResults?.max ?? 50,
      pageSize: pagination.pageSize,
    };
  }

  return {
    manifestVersion: 1,
    providerId: entry.type,
    displayName: entry.name,
    description: entry.description,
    category: entry.category,
    capability: entry.capability ?? "raw_search",
    version: "0.1.4",
    auth: {
      type: entry.authType,
      credentialKind: entry.credentialKind ?? "single",
      required: entry.authType !== "none" && entry.implementation !== "unavailable",
      fields: (entry.fields ?? []).filter((field) => (field.target ?? "config") === "credential"),
    },
    configuration: {
      ...(entry.defaultBaseUrl === undefined ? {} : { defaultEndpoint: entry.defaultBaseUrl }),
      // Only Trusted/custom transports may repoint the endpoint; a builtin
      // adapter with a fixed vendor host stays fixed.
      endpointEditable: entry.category === "compat" || entry.category === "custom",
      fields: (entry.fields ?? []).filter((field) => (field.target ?? "config") !== "credential"),
    },
    parameters: { supported, limits },
    pagination,
    accountQuota: entry.accountQuota ?? PER_KEY_QUOTA,
    resultMapping: entry.resultMapping ?? DEFAULT_MAPPING,
    ...(entry.docsUrl === undefined ? {} : { documentationUrl: entry.docsUrl }),
    verificationStatus: entry.verification,
    implementationStatus: entry.implementation,
  };
}

export function buildManifests(entries: ProviderCatalogEntry[]): ProviderManifest[] {
  return entries.map(buildManifest);
}

/**
 * Validates a per-instance search configuration against the manifest.
 *
 * Returns the problems instead of throwing so the API can answer 400 with every
 * unsupported field at once, and the UI can highlight them before saving.
 */
export function validateSearchConfig(
  manifest: ProviderManifest,
  config: Record<string, unknown>,
): string[] {
  const problems: string[] = [];

  const target = config["targetResults"];
  if (target !== undefined) {
    const limit = manifest.parameters.limits.targetResults ?? {};
    if (typeof target !== "number" || !Number.isInteger(target)) {
      problems.push("targetResults must be an integer");
    } else {
      if (limit.min !== undefined && target < limit.min) {
        problems.push(`targetResults must be >= ${limit.min}`);
      }
      if (limit.max !== undefined && target > limit.max) {
        problems.push(
          `${manifest.displayName} supports at most ${limit.max} results per search` +
            (manifest.pagination.supported ? "" : " (no pagination)"),
        );
      }
    }
  }

  const pages = config["maxPages"];
  if (pages !== undefined) {
    if (!manifest.pagination.supported) {
      problems.push(`${manifest.displayName} does not support pagination; remove maxPages`);
    } else if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) {
      problems.push("maxPages must be a positive integer");
    } else if (
      manifest.pagination.maxPages !== undefined &&
      pages > manifest.pagination.maxPages
    ) {
      problems.push(`${manifest.displayName} allows at most ${manifest.pagination.maxPages} pages`);
    }
  }

  const requests = config["maxRequestsPerSearch"];
  if (requests !== undefined && (typeof requests !== "number" || !Number.isInteger(requests) || requests < 1)) {
    problems.push("maxRequestsPerSearch must be a positive integer");
  }

  // targetResults / maxPages / maxRequestsPerSearch are validated above, with
  // messages that explain the vendor limit rather than a bare "unsupported".
  const HANDLED = new Set(["targetResults", "maxPages", "maxRequestsPerSearch", "locked"]);
  for (const [key, value] of Object.entries(config)) {
    if (HANDLED.has(key)) continue;
    if (!isParameterKey(key)) continue;
    if (!manifest.parameters.supported.includes(key)) {
      problems.push(`${manifest.displayName} does not support "${key}"`);
      continue;
    }
    const limits = manifest.parameters.limits[key];
    if (!limits) continue;
    if (typeof value === "number") {
      if (limits.min !== undefined && value < limits.min) problems.push(`${key} must be >= ${limits.min}`);
      if (limits.max !== undefined && value > limits.max) problems.push(`${key} must be <= ${limits.max}`);
    }
  }

  return problems;
}

const PARAMETER_KEYS: SearchParameterKey[] = [
  "targetResults",
  "maxPages",
  "maxRequestsPerSearch",
  "language",
  "region",
  "freshness",
  "safeSearch",
  "searchDepth",
  "includeDomains",
  "excludeDomains",
  "sort",
];

export function isParameterKey(value: string): value is SearchParameterKey {
  return (PARAMETER_KEYS as string[]).includes(value);
}

/**
 * Plans how many requests one search needs.
 *
 * A vendor's per-request page size is the hard constraint; the user's
 * `maxRequestsPerSearch` is a budget. The plan never promises more rows than
 * the budget can fetch, so the caller cannot accidentally exceed spend.
 */
export interface PaginationPlan {
  /** Requests to make, at least 1. */
  requests: number;
  /** Rows to ask for per request. */
  pageSize: number;
  /** Rows the plan can plausibly return. */
  expectedRows: number;
}

export function planPagination(
  manifest: ProviderManifest,
  options: { targetResults?: number; maxPages?: number; maxRequestsPerSearch?: number },
): PaginationPlan {
  const limit = manifest.parameters.limits.targetResults ?? {};
  const target = clamp(
    options.targetResults ?? (typeof limit.default === "number" ? limit.default : 10),
    limit.min ?? 1,
    limit.max ?? 50,
  );

  const pagination = manifest.pagination;
  if (!pagination.supported || !pagination.pageSize) {
    return { requests: 1, pageSize: target, expectedRows: target };
  }

  const pageSize = pagination.pageSize;
  const vendorPages = pagination.maxPages;
  const needed = Math.ceil(target / pageSize);
  const pageBudget = options.maxPages ?? needed;
  const requestBudget = options.maxRequestsPerSearch ?? needed;
  const requests = Math.max(
    1,
    Math.min(needed, pageBudget, requestBudget, vendorPages ?? Number.MAX_SAFE_INTEGER),
  );
  return { requests, pageSize, expectedRows: Math.min(target, requests * pageSize) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function dedupe(values: SearchParameterKey[]): SearchParameterKey[] {
  return [...new Set(values)];
}

/**
 * Resolves the effective search configuration for one provider instance.
 *
 * Precedence, highest first:
 *   1. a request-level override — but only when the admin did not lock it,
 *   2. the instance's `searchConfig`,
 *   3. the manifest default.
 * Every value is clamped to the vendor's own limits, so the resolved config can
 * never ask for something the provider forbids.
 */
export function resolveSearchConfig(
  manifest: ProviderManifest,
  instanceConfig: Record<string, unknown>,
  requestOverride?: { targetResults?: number; language?: string; freshness?: string },
): ResolvedSearchConfig {
  const locked = instanceConfig["locked"] === true;
  const plan = planPagination(manifest, {
    targetResults: pickNumber(locked ? undefined : requestOverride?.targetResults, instanceConfig["targetResults"]),
    maxPages: pickNumber(undefined, instanceConfig["maxPages"]),
    maxRequestsPerSearch: pickNumber(undefined, instanceConfig["maxRequestsPerSearch"]),
  });

  const regions = typeof instanceConfig["region"] === "string" ? instanceConfig["region"].trim() : "";
  const sort = typeof instanceConfig["sort"] === "string" ? instanceConfig["sort"].trim() : "";
  const safeRaw = instanceConfig["safeSearch"];
  const safeSearch =
    safeRaw === "off" || safeRaw === "moderate" || safeRaw === "strict" ? safeRaw : undefined;
  const depthRaw = instanceConfig["searchDepth"];
  const searchDepth =
    depthRaw === "fast" || depthRaw === "balanced" || depthRaw === "deep" ? depthRaw : undefined;

  return {
    targetResults: plan.expectedRows,
    maxPages: Math.max(1, plan.requests),
    maxRequestsPerSearch: Math.max(1, plan.requests),
    pageSize: plan.pageSize,
    ...(regions ? { region: regions } : {}),
    ...(safeSearch ? { safeSearch } : {}),
    ...(searchDepth ? { searchDepth } : {}),
    ...(parseDomains(instanceConfig["includeDomains"]).length > 0
      ? { includeDomains: parseDomains(instanceConfig["includeDomains"]) }
      : {}),
    ...(parseDomains(instanceConfig["excludeDomains"]).length > 0
      ? { excludeDomains: parseDomains(instanceConfig["excludeDomains"]) }
      : {}),
    ...(sort ? { sort } : {}),
  };
}

function pickNumber(primary: number | undefined, fallback: unknown): number | undefined {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return undefined;
}

function parseDomains(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((item) => item.length > 0)
    .slice(0, 50);
}
