/** Redact credentials and cookie material while preserving exit evidence. */
export function sanitizeLog(text) {
  return String(text)
    .replace(/(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|setup[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/("(?:token|apiKey|api_key|key|cookie|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

/**
 * Create a bounded streaming log sanitizer. Only a short marker lookbehind is
 * retained; sensitive line/value state is carried across arbitrary chunks.
 *
 * @returns {{write(chunk: string): string, end(): string}}
 */
export function createLogSanitizer() {
  const marker = /authorization\s*:|set-cookie\s*:|cookie\s*:|bearer\s+|"(?:token|apikey|api_key|key|cookie|authorization)"\s*:\s*|(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|setup[_-]?token|password|secret)\s*[:=]\s*/gi;
  const lookbehind = 128;
  let pending = "";
  let state = "normal";

  const processText = (text, final) => {
    let output = "";
    let rest = text;
    while (rest.length > 0) {
      if (state === "line") {
        const newline = rest.search(/[\r\n]/);
        if (newline < 0) return output;
        output += "\n";
        state = "normal";
        rest = rest.slice(newline + 1);
        continue;
      }
      if (state === "json_value") {
        if (rest.startsWith('"')) rest = rest.slice(1);
        let quote = -1;
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] !== '"') continue;
          let slashes = 0;
          for (let cursor = index - 1; cursor >= 0 && rest[cursor] === "\\"; cursor -= 1) slashes += 1;
          if (slashes % 2 === 0) { quote = index; break; }
        }
        if (quote < 0) return output;
        output += '"';
        state = "normal";
        rest = rest.slice(quote + 1);
        continue;
      }
      if (state === "value") {
        const delimiter = rest.search(/[\s,;&"]/);
        if (delimiter < 0) return output;
        output += rest[delimiter];
        state = "normal";
        rest = rest.slice(delimiter + 1);
        continue;
      }
      const combined = `${pending}${rest}`;
      pending = "";
      rest = "";
      marker.lastIndex = 0;
      const match = marker.exec(combined);
      if (match) {
        output += `${combined.slice(0, match.index)}[REDACTED]`;
        const markerText = match[0];
        state = /^(?:authorization|set-cookie|cookie)\s*:/i.test(markerText) ? "line" : markerText.startsWith('"') ? "json_value" : "value";
        rest = combined.slice(match.index + markerText.length);
      } else if (final) {
        output += combined;
      } else {
        const cut = Math.max(0, combined.length - lookbehind);
        output += combined.slice(0, cut);
        pending = combined.slice(cut);
      }
    }
    return output;
  };

  return {
    write(chunk) {
      return processText(String(chunk), false);
    },
    end() {
      const tail = pending;
      pending = "";
      return processText(tail, true);
    },
  };
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
