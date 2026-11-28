import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPublicSmoke } from "../../scripts/quality-public-smoke.mjs";

test("public smoke saves real-shaped evidence but never labels it ABBA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-public-smoke-"));
  try {
    const out = join(dir, "smoke.json");
    const report = await runPublicSmoke({
      provider: "wikipedia",
      query: "search engine",
      out,
      safeFetch: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        data: { query: { search: [{ title: "Search engine", pageid: 42, snippet: "A <span>search engine</span> article.", timestamp: "2026-01-01T00:00:00Z" }] } },
        url: "https://en.wikipedia.org/w/api.php",
      }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.abba, false);
    assert.equal(report.evidenceKind, "single_implementation_public_provider");
    assert.equal(report.results[0].url, "https://en.wikipedia.org/?curid=42");
    assert.match(report.resultHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public smoke records network failure without inventing a result", async () => {
  const report = await runPublicSmoke({
    provider: "duckduckgo",
    query: "search engine",
    safeFetch: async () => { throw new TypeError("network unavailable"); },
  });
  assert.equal(report.ok, false);
  assert.match(report.error, /Request to duckduckgo failed/);
  assert.equal(report.results, undefined);
  assert.equal(report.abba, false);
});

test("public smoke rejects unsupported providers and empty queries", async () => {
  await assert.rejects(runPublicSmoke({ provider: "paid", query: "x" }), /unsupported public provider/);
  await assert.rejects(runPublicSmoke({ provider: "wikipedia", query: "" }), /query is required/);
});
