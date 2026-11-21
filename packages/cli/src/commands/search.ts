import { searchRequestSchema } from "@search-hub/shared";
import { stringList, stringValue, numberValue, type ParsedCliArgs } from "../args.js";
import { HttpClient, HttpResponseError, ensureCompatible, validateTimeout } from "../client/http.js";
import { EXIT_CODES, usageError } from "../errors/index.js";
import { diag, table, writeJson, writeNdjson, writeText, type OutputFormat } from "../output/index.js";
import type { SearchCommandResponse } from "../types.js";

function isSearchResponse(value: unknown): value is SearchCommandResponse {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["taskId"] === "string" &&
    typeof candidate["status"] === "string" &&
    Array.isArray(candidate["results"]) &&
    Array.isArray(candidate["errors"]) &&
    Array.isArray(candidate["failedSources"])
  );
}

function emitNdjson(response: SearchCommandResponse): void {
  writeNdjson({
    type: "metadata",
    streaming: false,
    taskId: response.taskId,
    query: response.query,
    mode: response.mode,
    status: response.status,
  });
  for (const result of response.results) writeNdjson({ type: "result", result });
  writeNdjson({
    type: "complete",
    taskId: response.taskId,
    status: response.status,
    stats: response.stats,
    errors: response.errors,
    failedSources: response.failedSources,
    ...(response.answers === undefined ? {} : { answers: response.answers }),
    ...(response.summary === undefined ? {} : { summary: response.summary }),
    ...(response.debug === undefined ? {} : { debug: response.debug }),
  });
}

function emitTable(response: SearchCommandResponse): void {
  if (response.results.length > 0) {
    writeText(
      table(
        ["#", "Title", "Provider", "URL"],
        response.results.map((result, index) => [
          index + 1,
          result.title,
          result.providerName || result.provider,
          result.url,
        ]),
      ),
    );
  } else {
    writeText("No results.");
  }
  if (response.summary?.text) writeText(`\nSummary:\n${response.summary.text}`);
  if (response.errors.length > 0) {
    writeText(
      `\nErrors:\n${table(
        ["Provider", "Code", "Message"],
        response.errors.map((error) => [error.providerName, error.code, error.message]),
      )}`,
    );
  }
  writeText(
    `\nStatus: ${response.status} | taskId: ${response.taskId} | results: ${response.results.length} | providers: ${response.stats.providers.length}`,
  );
}

export async function runSearch(
  args: ParsedCliArgs,
  client: HttpClient,
  format: OutputFormat,
): Promise<number> {
  const query = args.positionals.slice(1).join(" ").trim();
  if (!query) throw usageError("search requires a query");
  const timeoutMs = validateTimeout(numberValue(args.values, "timeout", { min: 1000, max: 120_000 }), undefined);
  const input = {
    query,
    ...(stringList(args.values, "provider") === undefined ? {} : { providers: stringList(args.values, "provider") }),
    ...(stringValue(args.values, "group") === undefined ? {} : { group: stringValue(args.values, "group") }),
    ...(numberValue(args.values, "limit", { min: 1, max: 100 }) === undefined
      ? {}
      : { limit: numberValue(args.values, "limit", { min: 1, max: 100 }) }),
    ...(stringValue(args.values, "mode") === undefined ? {} : { mode: stringValue(args.values, "mode") }),
    ...(stringValue(args.values, "language") === undefined ? {} : { language: stringValue(args.values, "language") }),
    ...(stringValue(args.values, "freshness") === undefined ? {} : { freshness: stringValue(args.values, "freshness") }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const parsed = searchRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw usageError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  }

  await ensureCompatible(client);
  const path = parsed.data.mode === "deep" ? "/api/search/deep" : "/api/search";
  let response: SearchCommandResponse;
  try {
    response = await client.request<SearchCommandResponse>(path, {
      method: "POST",
      body: parsed.data,
      timeoutMs: timeoutMs === undefined ? undefined : timeoutMs,
    });
  } catch (error) {
    if (error instanceof HttpResponseError && isSearchResponse(error.body)) {
      response = error.body;
    } else {
      throw error;
    }
  }

  if (!isSearchResponse(response)) {
    throw new HttpResponseError(200, "invalid_response", "Search Hub returned an invalid search response", response);
  }
  if (format === "json") writeJson(response);
  else if (format === "ndjson") emitNdjson(response);
  else emitTable(response);

  if (response.status === "failed") {
    diag("Search failed; the full server response was preserved.");
    return EXIT_CODES.server;
  }
  if (response.status === "partial") {
    diag("Search completed partially; valid results were preserved.");
    return args.values["strict"] === true ? EXIT_CODES.server : EXIT_CODES.ok;
  }
  return EXIT_CODES.ok;
}
