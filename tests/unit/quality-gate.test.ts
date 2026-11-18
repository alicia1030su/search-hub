/**
 * Guards for the offline evaluation lab.
 *
 * The point of these tests is that the *docs* and the *gate* cannot drift from
 * the code: the CI step runs `quality:eval`, so a metric change that alters the
 * fixture numbers has to be acknowledged by updating the committed baseline,
 * and a silent regression fails the build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const script = join(root, "scripts", "quality-eval.mjs");
const tempDirs: string[] = [];

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-eval-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const caught = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: caught.stdout ?? "", stderr: caught.stderr ?? "", code: caught.status ?? 1 };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quality:eval", () => {
  it("passes with the committed baseline and writes a report", () => {
    const baseline = join(root, "tests", "fixtures", "quality-baseline.json");
    expect(existsSync(baseline), "the committed baseline is what CI compares against").toBe(true);
    const out = tempFile("report.json");
    const result = run(["--baseline", baseline, "--out", out]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS");
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      format: string;
      origin: string;
      dataset: { queries: number; judgments: number };
      selfChecks: Array<{ passed: boolean }>;
      strategies: Record<string, { metrics: { ndcgAtK: { status: string; value: number } } }>;
      selection: { chosenK: number | null; evidence: string };
      regression: { status: string; delta: number } | null;
    };
    expect(report.format).toBe("search-hub.quality.report/1");
    expect(report.origin).toBe("synthetic_fixture");
    expect(report.dataset.queries).toBe(14);
    expect(report.selfChecks.every((check) => check.passed)).toBe(true);
    expect(report.regression?.status).toBe("ok");
    // The production default must still be measured, and the report must still
    // carry a real number for it.
    expect(report.strategies["rrf:k=60"]!.metrics.ndcgAtK.status).toBe("ok");
  });

  it("is byte-stable across two runs of the same code", () => {
    const baseline = join(root, "tests", "fixtures", "quality-baseline.json");
    const a = tempFile("a.json");
    const b = tempFile("b.json");
    expect(run(["--baseline", baseline, "--out", a]).code).toBe(0);
    expect(run(["--baseline", baseline, "--out", b]).code).toBe(0);
    const first = JSON.parse(readFileSync(a, "utf8")) as Record<string, unknown>;
    const second = JSON.parse(readFileSync(b, "utf8")) as Record<string, unknown>;
    // `generatedAt` is the only field allowed to differ.
    delete first["generatedAt"];
    delete second["generatedAt"];
    expect(second).toEqual(first);
  });

  it("fails with a regression verdict when a baseline reports a higher score", () => {
    const baseline = join(root, "tests", "fixtures", "quality-baseline.json");
    const inflated = JSON.parse(readFileSync(baseline, "utf8")) as Record<string, unknown>;
    const strategies = inflated["strategies"] as Record<string, { metrics: Record<string, { value: number }> }>;
    strategies["rrf:k=60"]!.metrics["ndcgAtK"]!.value = 0.9999;
    const path = tempFile("inflated.json");
    writeFileSync(path, JSON.stringify(inflated), "utf8");
    const result = run(["--baseline", path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("REGRESSION");
  });

  it("refuses a malformed flag value instead of guessing", () => {
    const result = run(["--cutoff", "0"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--cutoff");
  });
});
