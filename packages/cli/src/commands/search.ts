import { searchRequestSchema } from "@search-hub/shared";
import { stringList, stringValue, numberValue, type ParsedCliArgs } from "../args.js";
import { HttpClient, HttpResponseError, ensureCompatible, validateTimeout } from "../client/http.js";
import { CliError, EXIT_CODES, usageError } from "../errors/index.js";
import { diag, table, writeJson, writeNdjson, writeText, type OutputFormat } from "../output/index.js";
import type { SearchCommandResponse } from "../types.js";

type StreamFormat = "sse" | "ndjson";

interface SearchStreamEvent {
  type: "meta" | "results" | "status" | "done" | "error";
  sequence: number;
  final: boolean;
  [key: string]: unknown;
}

const MAX_STREAM_BYTES = 16 * 1024 * 1024;

function isSearchResponse(value: unknown): value is SearchCommandResponse {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["taskId"] === "string" &&
    typeof candidate["status"] === "string" &&
    Array.isArray(candidate["results"]) &&
    Array.isArray(candidate["errors"]) &&
    Array.isArray(candidate["failedSources"]) &&
    candidate["stats"] !== null &&
    typeof candidate["stats"] === "object"
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

/** Incrementally decodes the shared SSE/NDJSON search event grammar. */
export class SearchStreamDecoder {
  private buffer = "";
  private bytes = 0;
  private sequence = 0;
  private terminalSeen = false;

  constructor(private readonly format: StreamFormat) {}

  /** Returns every complete event in a wire chunk, in sequence order. */
  push(chunk: string): SearchStreamEvent[] {
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (this.bytes > MAX_STREAM_BYTES) {
      throw new CliError("stream_too_large", "Search stream exceeds the 16 MiB CLI safety limit", EXIT_CODES.server);
    }
    if (this.terminalSeen) {
      throw new CliError("invalid_stream", "Search Hub sent data after the terminal event", EXIT_CODES.server);
    }
    this.buffer += chunk;
    if (this.format === "ndjson") return this.takeLines();
    return this.takeSseFrames();
  }

  /** Validates that the stream ended cleanly at its terminal event. */
  finish(): void {
    if (this.buffer.length > 0 || !this.terminalSeen) {
      throw new CliError("incomplete_stream", "Search stream ended before a complete terminal event", EXIT_CODES.server);
    }
  }

  private takeLines(): SearchStreamEvent[] {
    const events: SearchStreamEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0 && !this.terminalSeen) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        const event = this.parseEvent(line);
        if (event) events.push(event);
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.terminalSeen) this.buffer = "";
    return events;
  }

  private takeSseFrames(): SearchStreamEvent[] {
    const events: SearchStreamEvent[] = [];
    let boundary = /\r?\n\r?\n/.exec(this.buffer);
    while (boundary && !this.terminalSeen) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0) {
        const event = this.parseEvent(data);
        if (event) events.push(event);
      }
      boundary = /\r?\n\r?\n/.exec(this.buffer);
    }
    if (this.terminalSeen) this.buffer = "";
    return events;
  }

  private parseEvent(data: string): SearchStreamEvent | null {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new CliError("invalid_stream", "Search Hub sent malformed stream JSON", EXIT_CODES.server);
    }
    if (value === null || typeof value !== "object") {
      throw new CliError("invalid_stream", "Search Hub sent an invalid stream event", EXIT_CODES.server);
    }
    const event = value as Record<string, unknown>;
    if (event["type"] === "heartbeat" && event["sequence"] === undefined) return null;
    if (
      typeof event["type"] !== "string" ||
      !["meta", "results", "status", "done", "error"].includes(event["type"]) ||
      !Number.isSafeInteger(event["sequence"]) ||
      typeof event["final"] !== "boolean"
    ) {
      throw new CliError("invalid_stream", "Search Hub sent an invalid stream event", EXIT_CODES.server);
    }
    const terminal = event["type"] === "done" || event["type"] === "error" || isCancelledEvent(event);
    if (event["final"] !== terminal || event["sequence"] !== this.sequence + 1 || this.terminalSeen) {
      throw new CliError("invalid_stream", "Search Hub sent an out-of-order stream event", EXIT_CODES.server);
    }
    this.sequence += 1;
    this.terminalSeen = terminal;
    return event as unknown as SearchStreamEvent;
  }
}

function streamFormat(values: ParsedCliArgs["values"]): StreamFormat {
  const format = stringValue(values, "stream-format") ?? "sse";
  if (format !== "sse" && format !== "ndjson") {
    throw usageError("--stream-format must be one of: sse, ndjson");
  }
  if (values["stream"] !== true) throw usageError("--stream-format requires --stream");
  return format;
}

function isCancelledEvent(event: Record<string, unknown>): boolean {
  return event["type"] === "status" && event["status"] === "cancelled" && event["terminal"] === true;
}

function responseFromTerminal(event: SearchStreamEvent): SearchCommandResponse {
  const response = Object.fromEntries(
    Object.entries(event).filter(([key]) => !["type", "sequence", "final", "resultSet"].includes(key)),
  );
  if (!isSearchResponse(response)) {
    throw new HttpResponseError(200, "invalid_response", "Search Hub returned an invalid final search response", response);
  }
  return response;
}

function terminalMessage(event: SearchStreamEvent): string {
  const message = event["message"];
  if (typeof message === "string" && message.length > 0) return message;
  const code = event["code"] ?? (isCancelledEvent(event) ? "cancelled" : undefined);
  return typeof code === "string" && code.length > 0 ? `Search ${event["type"]}: ${code}` : `Search ${event["type"]}`;
}

function eventDetails(event: SearchStreamEvent): string {
  const keys = ["stage", "provider", "providerId", "providerName", "count", "status", "mode"];
  return keys.flatMap((key) => (event[key] === undefined ? [] : [`${key}=${String(event[key])}`])).join(" ");
}

function emitStreamEvent(event: SearchStreamEvent, format: OutputFormat, client: HttpClient): void {
  const safeEvent = client.redact(event) as SearchStreamEvent;
  if (format !== "table") {
    const output: Record<string, unknown> = { ...safeEvent, streaming: true };
    if (event.type === "results") output["resultSet"] = "temporary";
    if (event.type === "done" || event.type === "error" || isCancelledEvent(event)) output["resultSet"] = "final";
    if (format === "ndjson") writeNdjson(output);
    else writeJson(output);
    return;
  }
  switch (event.type) {
    case "meta":
      writeText(`[meta] taskId=${String(safeEvent["taskId"] ?? "unknown")} mode=${String(safeEvent["mode"] ?? "unknown")}`);
      break;
    case "status": {
      if (isCancelledEvent(event)) {
        writeText(`[cancelled] [final] ${terminalMessage(safeEvent)}`);
        break;
      }
      const stage = String(safeEvent["stage"] ?? "status");
      const label = stage.startsWith("provider_") ? "provider" : "progress";
      writeText(`[${label}] ${eventDetails(safeEvent)}`);
      break;
    }
    case "results": {
      const results = Array.isArray(safeEvent["results"]) ? safeEvent["results"] : [];
      writeText(`[results_updated] [temporary] count=${results.length} ${eventDetails(safeEvent)}`);
      const rows = results.flatMap((result: unknown, index: number) => {
        if (result === null || typeof result !== "object") return [];
        const item = result as Record<string, unknown>;
        if (typeof item["title"] !== "string" || typeof item["url"] !== "string") return [];
        return [[index + 1, item["title"], String(item["providerName"] ?? item["provider"] ?? "unknown"), item["url"]]] as Array<Array<string | number>>;
      });
      if (rows.length > 0) writeText(table(["#", "Title", "Provider", "URL"], rows));
      break;
    }
    case "done": {
      const response = client.redact(responseFromTerminal(event)) as SearchCommandResponse;
      writeText("[done] [final] authoritative final result");
      emitTable(response);
      break;
    }
    case "error":
      writeText(`[error] [final] ${terminalMessage(safeEvent)}`);
      if (isSearchResponse(safeEvent)) {
        writeText(table(
          ["#", "Title", "Provider", "URL"],
          safeEvent.results.map((result, index) => [index + 1, result.title, result.providerName || result.provider, result.url]),
        ));
      }
      break;
  }
}

function searchExitCode(response: SearchCommandResponse, strict: boolean): number {
  if (response.status === "failed") return EXIT_CODES.server;
  if (response.status === "partial") return strict ? EXIT_CODES.server : EXIT_CODES.ok;
  return EXIT_CODES.ok;
}

async function runStreamingSearch(
  client: HttpClient,
  input: Record<string, unknown>,
  format: OutputFormat,
  wireFormat: StreamFormat,
  timeoutMs: number | undefined,
  strict: boolean,
): Promise<number> {
  return await client.consumeStream(
    "/api/search/stream",
    {
      method: "POST",
      body: { ...input, stream: wireFormat },
      headers: { accept: wireFormat === "sse" ? "text/event-stream" : "application/x-ndjson" },
      timeoutMs,
    },
    async (response) => {
      const expectedType = wireFormat === "sse" ? "text/event-stream" : "application/x-ndjson";
      if (!response.headers.get("content-type")?.includes(expectedType) || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new CliError("invalid_stream", `Search Hub did not return ${expectedType}`, EXIT_CODES.incompatible);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SearchStreamDecoder(wireFormat);
      let terminal: SearchStreamEvent | undefined;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            emitStreamEvent(event, format, client);
            if (event.final) {
              terminal = event;
              break;
            }
          }
          if (terminal) break;
        }
        if (!terminal) {
          parser.finish();
          throw new CliError("incomplete_stream", "Search stream ended before a terminal event", EXIT_CODES.server);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return terminal;
    },
  ).then((terminal) => {
    if (terminal.type === "error" || isCancelledEvent(terminal)) {
      diag(terminalMessage(client.redact(terminal) as SearchStreamEvent));
      return isCancelledEvent(terminal) ? EXIT_CODES.interrupted : EXIT_CODES.server;
    }
    const response = responseFromTerminal(terminal);
    if (response.status === "partial") diag("Search completed partially; valid results were preserved.");
    return searchExitCode(response, strict);
  });
}

export async function runSearch(
  args: ParsedCliArgs,
  client: HttpClient,
  format: OutputFormat,
): Promise<number> {
  const query = args.positionals.slice(1).join(" ").trim();
  if (!query) throw usageError("search requires a query");
  const timeoutMs = validateTimeout(numberValue(args.values, "timeout", { min: 1000, max: 120_000 }), undefined);
  const wireFormat = args.values["stream"] === true ? streamFormat(args.values) : undefined;
  if (args.values["stream-format"] !== undefined && wireFormat === undefined) streamFormat(args.values);
  const input = {
    query,
    ...(stringList(args.values, "provider") === undefined ? {} : { providers: stringList(args.values, "provider") }),
    ...(stringValue(args.values, "group") === undefined ? {} : { group: stringValue(args.values, "group") }),
    ...(numberValue(args.values, "limit", { min: 1, max: 100 }) === undefined
      ? {}
      : { limit: numberValue(args.values, "limit", { min: 1, max: 100 }) }),
    ...(stringValue(args.values, "mode") === undefined ? { mode: "basic" } : { mode: stringValue(args.values, "mode") }),
    ...(stringValue(args.values, "language") === undefined ? {} : { language: stringValue(args.values, "language") }),
    ...(stringValue(args.values, "freshness") === undefined ? {} : { freshness: stringValue(args.values, "freshness") }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const parsed = searchRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw usageError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  }

  await ensureCompatible(client);
  if (wireFormat !== undefined) {
    return await runStreamingSearch(client, parsed.data, format, wireFormat, timeoutMs, args.values["strict"] === true);
  }
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
