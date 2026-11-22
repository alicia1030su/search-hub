import { createInterface } from "node:readline/promises";
import type { ParsedCliArgs } from "../args.js";
import { stringValue } from "../args.js";
import { HttpClient, ensureCompatible, requireToken } from "../client/http.js";
import { EXIT_CODES, interruptedError, usageError } from "../errors/index.js";
import { diag, table, writeJson, writeNdjson, writeText, type OutputFormat } from "../output/index.js";
import type { BatchJob, BatchPreview, SingleProbeResponse } from "../types.js";

function probeKind(args: ParsedCliArgs): "connect" | "search" {
  const kind = stringValue(args.values, "kind") ?? "search";
  if (kind !== "connect" && kind !== "search") throw usageError("--kind must be connect or search");
  return kind;
}

function previewPath(kind: "connect" | "search", providerId?: string, includeKeyless = false): string {
  const query = new URLSearchParams({ kind, includeKeyless: String(includeKeyless) });
  if (providerId) query.set("providerIds", providerId);
  return `/api/admin/provider-health/batch-test/preview?${query.toString()}`;
}

async function confirmCost(preview: BatchPreview, confirmed: boolean, signal?: AbortSignal): Promise<void> {
  const risky = preview.paidRisk || preview.estimatedPaidProbes > 0;
  if (!risky || confirmed) return;
  const message = `This may run ${preview.estimatedPaidProbes} paid provider probe(s) and consume third-party quota.`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw usageError(`${message} Re-run with --confirm-cost for unattended use.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message} Continue? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) throw usageError("Provider test cancelled; no request was sent");
  } finally {
    rl.close();
  }
  if (signal?.aborted) throw interruptedError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(interruptedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(interruptedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollJob(
  client: HttpClient,
  jobId: string,
  verbose: boolean,
  pollInterval: number,
  signal?: AbortSignal,
): Promise<{ job: BatchJob; exitCode: number }> {
  for (;;) {
    const job = await client.request<BatchJob>(`/api/admin/provider-health/batch-test/${encodeURIComponent(jobId)}`);
    if (verbose && job.status === "running") {
      diag(`${job.counts.done}/${job.counts.total} done, ${job.counts.remaining} remaining`);
    }
    if (job.status !== "running") {
      const exitCode = job.status === "completed" || job.status === "cancelled" ? EXIT_CODES.ok : EXIT_CODES.server;
      return { job, exitCode };
    }
    await sleep(job.nextPollAfterMs ?? pollInterval, signal);
  }
}

function emitJob(job: BatchJob, format: OutputFormat): void {
  if (format === "json") {
    writeJson(job);
    return;
  }
  if (format === "ndjson") {
    writeNdjson({ type: "batch_job", ...job });
    return;
  }
  writeText(
    table(
      ["Provider", "Type", "State", "Code", "Latency", "Results", "Requests", "Reason"],
      job.items.map((item) => [
        item.providerName,
        item.providerType,
        item.state,
        item.code,
        item.latencyMs,
        item.resultCount,
        item.requests,
        item.reason,
      ]),
    ),
  );
  writeText(`\nStatus: ${job.status} | done=${job.counts.done}/${job.counts.total} | ok=${job.counts.ok} failed=${job.counts.failed} skipped=${job.counts.skipped}`);
}

async function runSingle(
  args: ParsedCliArgs,
  client: HttpClient,
  format: OutputFormat,
  signal?: AbortSignal,
): Promise<number> {
  const providerId = args.positionals[2];
  if (!providerId) throw usageError("providers test requires a provider id or --all");
  const kind = probeKind(args);
  const preview = await client.request<BatchPreview>(previewPath(kind, providerId, false));
  if (preview.counts.eligible === 0) {
    if (format === "json") writeJson({ skipped: true, preview });
    else if (format === "ndjson") writeNdjson({ type: "preview", skipped: true, preview });
    else writeText(`Skipped ${providerId}: ${preview.counts.noKey} no key, ${preview.counts.noEnabledKey} disabled key, ${preview.counts.disabled} disabled source.`);
    return EXIT_CODES.ok;
  }
  await confirmCost(preview, args.values["confirm-cost"] === true, signal);
  const keyId = stringValue(args.values, "key-id");
  const response = await client.request<SingleProbeResponse>(
    `/api/admin/provider-health/${encodeURIComponent(providerId)}/probe`,
    { method: "POST", body: { kind, ...(keyId === undefined ? {} : { keyId }) } },
  );
  if (format === "json") writeJson(response);
  else if (format === "ndjson") writeNdjson({ type: "provider_probe", ...response });
  else {
    const result = response.result;
    writeText(
      table(
        ["Field", "Value"],
        [
          ["Provider", providerId],
          ["Kind", result.kind],
          ["Status", result.status],
          ["Cause", result.cause],
          ["OK", result.ok],
          ["Latency (ms)", result.latencyMs],
          ["Results", result.resultCount],
          ["Requests", result.requests],
          ["Billing unit", result.billingUnit],
          ["Message", result.message],
        ],
      ),
    );
  }
  return response.result.ok ? EXIT_CODES.ok : EXIT_CODES.server;
}

async function runBatch(
  args: ParsedCliArgs,
  client: HttpClient,
  format: OutputFormat,
  verbose: boolean,
  pollInterval: number,
  signal?: AbortSignal,
): Promise<number> {
  const kind = probeKind(args);
  const includeKeyless = args.values["include-keyless"] === true;
  const preview = await client.request<BatchPreview>(previewPath(kind, undefined, includeKeyless));
  if (preview.counts.eligible === 0) {
    if (format === "json") writeJson({ skipped: true, preview });
    else if (format === "ndjson") writeNdjson({ type: "preview", skipped: true, preview });
    else writeText(`No eligible providers. Preview: ${JSON.stringify(preview.counts)}`);
    return EXIT_CODES.ok;
  }
  await confirmCost(preview, args.values["confirm-cost"] === true, signal);
  const started = await client.request<{ jobId: string; status: string; total: number; concurrency: number }>(
    "/api/admin/provider-health/batch-test",
    { method: "POST", body: { kind, includeKeyless } },
  );
  if (verbose) diag(`Started ${started.jobId} (${started.total} providers)`);
  const { job, exitCode } = await pollJob(client, started.jobId, verbose, pollInterval, signal);
  emitJob(job, format);
  return exitCode;
}

export async function runProvidersTest(
  args: ParsedCliArgs,
  client: HttpClient,
  token: string | undefined,
  format: OutputFormat,
  pollInterval: number,
  signal?: AbortSignal,
): Promise<number> {
  requireToken(token);
  await ensureCompatible(client);

  const cancelId = stringValue(args.values, "cancel");
  if (cancelId) {
    const result = await client.request(`/api/admin/provider-health/batch-test/${encodeURIComponent(cancelId)}/cancel`, { method: "POST", body: {} });
    if (format === "json") writeJson(result);
    else if (format === "ndjson") writeNdjson({ type: "batch_cancel", ...(result as object) });
    else writeText(JSON.stringify(result));
    return EXIT_CODES.ok;
  }

  const existingJob = stringValue(args.values, "job");
  if (existingJob) {
    const { job, exitCode } = await pollJob(client, existingJob, args.values["verbose"] === true, pollInterval, signal);
    emitJob(job, format);
    return exitCode;
  }

  if (args.values["all"] === true) return runBatch(args, client, format, args.values["verbose"] === true, pollInterval, signal);
  return runSingle(args, client, format, signal);
}
