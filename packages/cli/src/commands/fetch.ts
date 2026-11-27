import { numberValue, type ParsedCliArgs } from "../args.js";
import { ensureCompatible, HttpResponseError, type HttpClient } from "../client/http.js";
import { EXIT_CODES, usageError } from "../errors/index.js";
import { diag, writeJson, writeText, type OutputFormat } from "../output/index.js";

interface WebpageReadResponse {
  title: string | null;
  content: string | null;
  requestedUrl: string;
  finalUrl: string;
  contentLength: number;
  readStatus: string;
  truncated: boolean;
  reasonCode: string;
}

function isWebpageReadResponse(value: unknown): value is WebpageReadResponse {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["readStatus"] === "string" &&
    typeof candidate["reasonCode"] === "string" &&
    typeof candidate["requestedUrl"] === "string" &&
    typeof candidate["finalUrl"] === "string" &&
    typeof candidate["contentLength"] === "number" &&
    typeof candidate["truncated"] === "boolean" &&
    (candidate["content"] === null || typeof candidate["content"] === "string")
  );
}

function validateWebpageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError("fetch requires a valid HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw usageError("fetch requires an HTTP(S) URL without credentials");
  }
  return url.toString();
}

export async function runFetch(args: ParsedCliArgs, client: HttpClient, format: OutputFormat): Promise<number> {
  const rawUrl = args.positionals[1];
  if (!rawUrl) throw usageError("usage: shub fetch <URL> [--max-chars N] [--json]");
  const url = validateWebpageUrl(rawUrl);
  const maxContentChars = numberValue(args.values, "max-chars", { min: 1, max: 500_000 });
  await ensureCompatible(client);

  let response: WebpageReadResponse;
  let failure: HttpResponseError | undefined;
  try {
    response = await client.request<WebpageReadResponse>("/api/web/read", {
      method: "POST",
      body: { url, ...(maxContentChars === undefined ? {} : { maxContentChars }) },
    });
  } catch (error) {
    if (!(error instanceof HttpResponseError) || !isWebpageReadResponse(error.body)) throw error;
    response = error.body;
    failure = error;
  }

  if (!isWebpageReadResponse(response)) {
    throw new HttpResponseError(200, "invalid_response", "Search Hub returned an invalid webpage response", response);
  }
  if (format === "json" || format === "ndjson" || response.readStatus !== "ok") writeJson(response);
  else writeText(response.content ?? "");

  if (failure) {
    diag(`Webpage unavailable: ${response.readStatus} (${response.reasonCode})`);
    return failure.status === 422 ? EXIT_CODES.content_unavailable : failure.exitCode;
  }
  if (response.truncated) diag("Webpage content was truncated at the requested character limit.");
  return 0;
}
