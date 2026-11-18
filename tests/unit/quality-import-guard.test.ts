/**
 * Import guards and download-name sanitisation.
 *
 * A dataset import is a document this process did not produce. None of these
 * checks is about executing an attacker's payload — nothing here is evaluated —
 * they are about the quieter failures: a prototype that mutates because a key
 * was merged, a stack that overflows on a deeply nested object, a URL that
 * claims to be a document but cannot be fetched, and a filename that lands in a
 * response header.
 */
import { describe, expect, it } from "vitest";
import {
  ImportRejection,
  MAX_IMPORT_DEPTH,
  assertCleanText,
  assertDocumentUrl,
  assertSafePayload,
  safeDownloadName,
} from "../../apps/api/src/services/quality-import-guard.js";

describe("assertSafePayload", () => {
  it("accepts an ordinary dataset payload", () => {
    expect(() =>
      assertSafePayload({
        name: "set",
        queries: [{ query: "typescript satisfies", judgments: [{ url: "https://a.test/1", relevance: 3 }] }],
      }),
    ).not.toThrow();
  });

  it("rejects a prototype-polluting key at the top level", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(() => assertSafePayload(payload)).toThrow(ImportRejection);
  });

  it("rejects a dangerous key nested inside an array element", () => {
    const payload = JSON.parse('{"queries":[{"constructor":{"prototype":{}}}]}') as unknown;
    expect(() => assertSafePayload(payload)).toThrow(/constructor|prototype/);
  });

  it("names the offending path so the caller can fix the file", () => {
    try {
      assertSafePayload({ queries: [{ query: "x", notes: JSON.parse('{"__proto__":{}}') }] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ImportRejection);
      expect((error as ImportRejection).path).toContain("queries[0]");
    }
  });

  it("rejects nesting beyond the documented depth", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index <= MAX_IMPORT_DEPTH + 1; index += 1) nested = { child: nested };
    expect(() => assertSafePayload(nested)).toThrow(/Nesting deeper/);
  });

  it("does not throw on a very wide payload", () => {
    const wide = { queries: Array.from({ length: 500 }, (_, index) => ({ query: `q${index}` })) };
    expect(() => assertSafePayload(wide)).not.toThrow();
  });
});

describe("assertCleanText", () => {
  it("accepts ordinary text, including non-ASCII", () => {
    expect(() => assertCleanText("中文查询 with spaces", "p")).not.toThrow();
  });

  it("rejects a NUL byte", () => {
    expect(() => assertCleanText("a\u0000b", "queries[0].query")).toThrow(/Control characters/);
  });

  it("rejects a newline that would break a header or a log line", () => {
    expect(() => assertCleanText("a\nb", "queries[0].query")).toThrow(/Control characters/);
  });
});

describe("assertDocumentUrl", () => {
  it("accepts http and https", () => {
    expect(() => assertDocumentUrl("https://a.fixture.test/1", "p")).not.toThrow();
    expect(() => assertDocumentUrl("http://a.fixture.test/1", "p")).not.toThrow();
  });

  it("rejects a file URL", () => {
    expect(() => assertDocumentUrl("file:///etc/passwd", "p")).toThrow(/not documents/);
  });

  it("rejects a javascript URL", () => {
    expect(() => assertDocumentUrl("javascript:alert(1)", "p")).toThrow();
  });

  it("rejects a data URL", () => {
    expect(() => assertDocumentUrl("data:text/html,<h1>x</h1>", "p")).toThrow();
  });

  it("rejects a relative path", () => {
    expect(() => assertDocumentUrl("../../etc/passwd", "p")).toThrow(/not an absolute URL/);
  });
});

describe("safeDownloadName", () => {
  it("keeps an ordinary name", () => {
    expect(safeDownloadName("core-fixture", "qd_1")).toBe("core-fixture.json");
  });

  it("removes path separators and traversal", () => {
    const name = safeDownloadName("../../etc/passwd", "qd_1");
    expect(name).toBe("etc_passwd.json");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("removes a newline so a header cannot be split", () => {
    expect(safeDownloadName("a\r\nX-Injected: 1", "qd_1")).not.toMatch(/[\r\n]/);
  });

  it("falls back to the dataset id rather than an empty filename", () => {
    expect(safeDownloadName("///", "qd_abc")).toBe("quality-dataset-qd_abc.json");
  });
});
