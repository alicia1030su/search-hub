import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Guard rails for the acceptance matrix (P1-4).
 *
 * `docs/ac-matrix.json` is the single source of truth for AC-01..AC-16. The
 * risk this file protects against is a hand-edited matrix that silently drops
 * an AC, invents a PASS without evidence, or reports PARTIAL/BLOCKED without
 * saying what is missing. Both the data and `scripts/ac-matrix.mjs` are tested
 * here: the data because a wrong status misleads the release decision, the
 * generator because a permissive validator would let the next edit through.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const jsonPath = join(repoRoot, "docs", "ac-matrix.json");
const mdPath = join(repoRoot, "docs", "ac-matrix.md");
const scriptPath = join(repoRoot, "scripts", "ac-matrix.mjs");

const STATUSES = ["PASS", "PARTIAL", "FAIL", "BLOCKED", "NOT_IMPLEMENTED"];
const EXPECTED_IDS = Array.from({ length: 16 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`);

interface Evidence {
  command: string;
  result: string;
}

interface AcItem {
  id: string;
  title: string;
  status: string;
  summary: string;
  evidence: Evidence[];
  gaps: string[];
}

function loadItems(): AcItem[] {
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as AcItem[] | { items: AcItem[] };
  return Array.isArray(parsed) ? parsed : parsed.items;
}

/** Run the generator; returns stdout plus the exit code instead of throwing. */
function runGenerator(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    const spawnError = error as { status?: number; stdout?: string; stderr?: string };
    return { code: spawnError.status ?? 1, out: `${spawnError.stdout ?? ""}${spawnError.stderr ?? ""}` };
  }
}

const tempDirs: string[] = [];

function tempMatrix(items: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-matrix-"));
  tempDirs.push(dir);
  const file = join(dir, "ac-matrix.json");
  writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
  return file;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const items = loadItems();

describe("docs/ac-matrix.json shape", () => {
  it("has exactly 16 entries, one per AC-01..AC-16, in order", () => {
    expect(items).toHaveLength(16);
    expect(items.map((item) => item.id)).toEqual(EXPECTED_IDS);
  });

  it("gives every entry exactly one status from the allowed set", () => {
    for (const item of items) {
      expect(typeof item.status, `${item.id} status type`).toBe("string");
      expect(STATUSES, `${item.id} status`).toContain(item.status);
    }
  });

  it("never repeats an id", () => {
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a non-empty title and summary for every entry", () => {
    for (const item of items) {
      expect(item.title.trim().length, `${item.id} title`).toBeGreaterThan(0);
      expect(item.summary.trim().length, `${item.id} summary`).toBeGreaterThan(0);
    }
  });

  it("gives every PASS at least one reproducible command + result", () => {
    for (const item of items.filter((entry) => entry.status === "PASS")) {
      expect(item.evidence.length, `${item.id} evidence count`).toBeGreaterThan(0);
      for (const entry of item.evidence) {
        expect(entry.command.trim().length, `${item.id} evidence command`).toBeGreaterThan(0);
        expect(entry.result.trim().length, `${item.id} evidence result`).toBeGreaterThan(0);
      }
    }
  });

  it("states what is missing for every non-PASS entry", () => {
    for (const item of items.filter((entry) => entry.status !== "PASS")) {
      expect(item.gaps.length, `${item.id} must explain its gap`).toBeGreaterThan(0);
      for (const gap of item.gaps) expect(gap.trim().length, `${item.id} gap text`).toBeGreaterThan(0);
    }
  });

  it("keeps the status counts reproducible from the data", () => {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(16);
  });
});

describe("scripts/ac-matrix.mjs", () => {
  it("validates the committed matrix", () => {
    const result = runGenerator(["--check"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("16 AC items are valid");
  });

  it("renders a markdown file with a 16-row table and status counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-matrix-out-"));
    tempDirs.push(dir);
    const outPath = join(dir, "ac-matrix.md");
    const result = runGenerator(["--out", outPath]);
    expect(result.code, result.out).toBe(0);

    const markdown = readFileSync(outPath, "utf8");
    const rows = markdown.split("\n").filter((line) => /^\|\s*AC-\d{2}\s*\|/.test(line));
    expect(rows).toHaveLength(16);
    for (const item of items) expect(markdown).toContain(`| ${item.id} |`);

    // The counts table must add up to 16, not to whatever was typed by hand.
    const countRows = markdown
      .split("\n")
      .map((line) => line.match(/^\|\s*(PASS|PARTIAL|FAIL|BLOCKED|NOT_IMPLEMENTED)\s*\|\s*(\d+)\s*\|\s*$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[2]));
    expect(countRows).toHaveLength(5);
    expect(countRows.reduce((sum, value) => sum + value, 0)).toBe(16);

    expect(markdown).toContain("生成时间");
    expect(markdown).toContain("docs/ac-matrix.json");
  });

  it("keeps docs/ac-matrix.md in sync with the JSON", () => {
    const markdown = readFileSync(mdPath, "utf8");
    const rows = markdown.split("\n").filter((line) => /^\|\s*AC-\d{2}\s*\|/.test(line));
    expect(rows).toHaveLength(16);
    for (const item of items) {
      expect(rows.some((row) => row.startsWith(`| ${item.id} |`)), `${item.id} missing from md`).toBe(true);
      // The rendered status must match the JSON, not a stale earlier verdict.
      const row = rows.find((line) => line.startsWith(`| ${item.id} |`))!;
      expect(row, `${item.id} status drift`).toContain(item.status);
    }
  });

  it("keeps the acceptance report's headline numbers equal to the matrix", () => {
    // The report quotes "PASS n / PARTIAL n / BLOCKED n" once. Two hand-edited
    // copies of the same tally is exactly how v0.1.1 drifted, so the quoted
    // numbers are checked against the machine-readable source here.
    const report = readFileSync(join(repoRoot, "docs", "acceptance-report.md"), "utf8");
    const headline = report.match(/PASS\s+(\d+)\s*\/\s*PARTIAL\s+(\d+)\s*\/\s*BLOCKED\s+(\d+)/);
    expect(headline, "acceptance-report must quote the matrix counts").not.toBeNull();
    const quoted = {
      PASS: Number(headline![1] ?? 0),
      PARTIAL: Number(headline![2] ?? 0),
      BLOCKED: Number(headline![3] ?? 0),
    };
    const actual: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const item of items) actual[item.status] = (actual[item.status] ?? 0) + 1;
    expect(quoted).toEqual({
      PASS: actual["PASS"],
      PARTIAL: actual["PARTIAL"],
      BLOCKED: actual["BLOCKED"],
    });
  });
});

describe("scripts/ac-matrix.mjs rejects broken matrices", () => {
  it("fails when the entry count is not 16", () => {
    const file = tempMatrix(items.slice(0, 15));
    const result = runGenerator(["--json", file, "--check"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("exactly 16 items");
  });

  it("fails on an unknown status", () => {
    const broken = items.map((item, index) => (index === 2 ? { ...item, status: "MAYBE" } : item));
    const result = runGenerator(["--json", tempMatrix(broken), "--check"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("invalid status");
  });

  it("fails when an id is out of order", () => {
    const broken = items.map((item, index) => (index === 5 ? { ...item, id: "AC-17" } : item));
    const result = runGenerator(["--json", tempMatrix(broken), "--check"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("must be AC-06");
  });

  it("fails when a PASS has no evidence", () => {
    const passIndex = items.findIndex((item) => item.status === "PASS");
    const broken = items.map((item, index) => (index === passIndex ? { ...item, evidence: [] } : item));
    const result = runGenerator(["--json", tempMatrix(broken), "--check"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("requires at least one evidence entry");
  });

  it("fails when a PARTIAL or BLOCKED entry has no gaps", () => {
    for (const status of ["PARTIAL", "BLOCKED"]) {
      const index = items.findIndex((item) => item.status !== "PASS");
      const broken = items.map((item, position) =>
        position === index ? { ...item, status, gaps: [] } : item,
      );
      const result = runGenerator(["--json", tempMatrix(broken), "--check"]);
      expect(result.code, `${status}: ${result.out}`).toBe(1);
      expect(result.out).toContain("requires at least one gap");
    }
  });

  it("fails when an evidence entry has an empty command or result", () => {
    const broken = items.map((item, index) =>
      index === 0 ? { ...item, evidence: [{ command: "", result: "" }] } : item,
    );
    const result = runGenerator(["--json", tempMatrix(broken), "--check"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('missing "command"');
    expect(result.out).toContain('missing "result"');
  });
});
