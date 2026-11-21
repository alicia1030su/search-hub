import type { CliError } from "../errors/index.js";

export type OutputFormat = "table" | "json" | "ndjson";

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeNdjson(value: unknown): void {
  writeJson(value);
}

export function writeText(value: string): void {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

export function diag(message: string): void {
  process.stderr.write(`shub: ${message}\n`);
}

export function writeError(error: CliError, format: OutputFormat): void {
  if (format === "json") {
    writeJson(error.toJSON());
    return;
  }
  if (format === "ndjson") {
    writeNdjson({ type: "error", ...error.toJSON() });
    return;
  }
  diag(error.message);
}

export function table(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const values = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return "—";
      return String(cell);
    }),
  );
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => (row[index] ?? "").length)),
  );
  const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(headers), line(headers.map((header, index) => "-".repeat(widths[index] ?? 0))), ...values.map(line)].join("\n");
}
