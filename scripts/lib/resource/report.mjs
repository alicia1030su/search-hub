/** Redact credentials and cookie material while preserving exit evidence. */
export function sanitizeLog(text) {
  return String(text)
    .replace(/(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|setup[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/("(?:token|apiKey|api_key|key|cookie|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

/** Build a bounded, non-sensitive verification report. */
export function buildReport({ runId, snapshot, budget, stages = [], oomRetries = [], residuals = [], exitCode = 0, reason = null }) {
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    exitCode,
    status: exitCode === 0 ? "success" : exitCode === 3 ? "resource_blocked" : exitCode === 4 ? "child_failed" : "internal",
    reason,
    snapshot,
    frozenBudget: budget,
    stages,
    oomRetries,
    residuals,
  };
}

/** Print only stage/status/exit/peak/retry/residual facts and the artifact path. */
export function printReportSummary(report, artifactPath = null) {
  const lines = [`resource verification: ${report.status} (exit ${report.exitCode})`];
  for (const stage of report.stages) {
    const peak = stage.rssPeakBytes?.value ?? null;
    lines.push(`${stage.stage}: ${stage.status}, exit=${stage.exitCode}, attempts=${stage.attempts}, workers=${stage.workers ?? "n/a"}, peakRssBytes=${peak ?? "unknown"}`);
  }
  lines.push(`oomRetries=${report.oomRetries.length}, residuals=${report.residuals.length}`);
  if (artifactPath) lines.push(`artifacts=${artifactPath}`);
  console.log(lines.join("\n"));
}
