import {
  SearchHubError,
  type ResolvedSearchIntent,
  type SearchMode,
  type SearchRequest,
  type SearchStrategy,
} from "@search-hub/shared";

function inferredStrategy(mode: SearchMode): SearchStrategy {
  if (mode === "deep") return "deep";
  if (mode === "basic" || mode === "web" || mode === "grounded") return "fast";
  if (mode === "rrf" || mode === "research") return "balanced";
  return "quality";
}

function conflict(strategy: SearchStrategy, mode: SearchMode): never {
  throw new SearchHubError(
    "validation_error",
    `Strategy "${strategy}" is incompatible with explicit mode "${mode}".`,
  );
}

/** Resolves strategy defaults without overriding an explicitly requested legacy mode. */
export function resolveSearchIntent(
  request: SearchRequest,
  defaultMode: SearchMode = "basic",
): ResolvedSearchIntent {
  const explicitMode = request.mode;
  const mode = explicitMode ?? defaultMode;
  const strategy = request.strategy;

  if (!strategy || strategy === "auto") {
    return {
      ...(strategy ? { strategy } : {}),
      mode,
      effectiveStrategy: strategy === "auto" ? inferredStrategy(mode) : inferredStrategy(mode),
      routeVersion: "v1",
    };
  }

  switch (strategy) {
    case "fast":
      if (explicitMode && explicitMode !== "basic") conflict(strategy, explicitMode);
      return { strategy, mode: explicitMode ?? "basic", effectiveStrategy: "fast", routeVersion: "v1" };
    case "balanced":
      if (explicitMode && explicitMode !== "rrf") conflict(strategy, explicitMode);
      return { strategy, mode: explicitMode ?? "rrf", effectiveStrategy: "balanced", routeVersion: "v1" };
    case "quality":
      if (explicitMode && !["basic", "rrf", "rerank"].includes(explicitMode)) conflict(strategy, explicitMode);
      return { strategy, mode: explicitMode ?? "rrf", effectiveStrategy: "quality", routeVersion: "v1" };
    case "deep":
      if (explicitMode && explicitMode !== "deep") conflict(strategy, explicitMode);
      return { strategy, mode: explicitMode ?? "deep", effectiveStrategy: "deep", routeVersion: "v1" };
    default:
      throw new SearchHubError("validation_error", `Unknown search strategy: ${String(strategy)}`);
  }
}
