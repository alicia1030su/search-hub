/**
 * Provenance fingerprints.
 *
 * A fingerprint exists so a stored score can be attributed. That only works if
 * it changes when the experiment changes and *stays* when something irrelevant
 * changes — above all, when an API key is rotated. These tests pin both
 * directions, because a fingerprint that drifts on a key rotation turns every
 * honest comparison into "different configuration".
 */
import { describe, expect, it } from "vitest";
import {
  modelFingerprint,
  providerFingerprint,
  qrelsFingerprint,
  shortFingerprint,
  type ProviderFingerprintRow,
} from "../../apps/api/src/services/quality-fingerprint.js";

function provider(overrides: Partial<ProviderFingerprintRow> = {}): ProviderFingerprintRow {
  return {
    id: "p1",
    type: "brave",
    baseUrl: "https://api.search.brave.com",
    weight: 100,
    timeoutMs: 12000,
    maxConcurrency: 4,
    resultsPerPage: 20,
    rpmLimit: 60,
    maxRetries: 1,
    searchConfig: { safeSearch: "moderate" },
    ...overrides,
  };
}

describe("providerFingerprint", () => {
  it("is stable for the same configuration", () => {
    expect(providerFingerprint([provider()])).toBe(providerFingerprint([provider()]));
  });

  it("does not change when the order of providers changes", () => {
    const a = providerFingerprint([provider({ id: "a" }), provider({ id: "b" })]);
    const b = providerFingerprint([provider({ id: "b" }), provider({ id: "a" })]);
    expect(a).toBe(b);
  });

  it("changes when a ranking-relevant setting changes", () => {
    const before = providerFingerprint([provider()]);
    const after = providerFingerprint([provider({ weight: 50 })]);
    expect(after).not.toBe(before);
    // Same value, same digest again: the function is a pure projection.
    expect(providerFingerprint([provider({ weight: 50 })])).toBe(after);
  });

  it("does not change when a credential is added to the projection", () => {
    // The scenario: a caller spreads a whole provider row instead of the
    // documented projection. The digest must ignore the key, or rotating one
    // would look like a configuration change.
    const withKey = {
      ...provider(),
      apiKey: "sk-live-abc123",
      bearerToken: "tok_xyz",
    } as unknown as ProviderFingerprintRow;
    expect(providerFingerprint([withKey])).toBe(providerFingerprint([provider()]));
  });

  it("ignores a secret nested inside searchConfig", () => {
    const withNested = provider({
      searchConfig: { safeSearch: "moderate", apiKey: "sk-inside", auth: { token: "t" } },
    });
    expect(providerFingerprint([withNested])).toBe(providerFingerprint([provider()]));
  });

  it("is null when no provider took part, never a digest of nothing", () => {
    expect(providerFingerprint([])).toBeNull();
  });

  it("is a 32-character hex digest", () => {
    expect(providerFingerprint([provider()])).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("qrelsFingerprint", () => {
  const rows = [
    { queryId: "q1", documentId: "https://a.fixture.test/1", relevance: 3 },
    { queryId: "q1", documentId: "https://b.fixture.test/1", relevance: 2 },
    { queryId: "q2", documentId: "https://c.fixture.test/1", relevance: 0 },
  ];

  it("changes when one grade changes", () => {
    const before = qrelsFingerprint(rows, true);
    const after = qrelsFingerprint(
      rows.map((row) =>
        row.documentId === "https://b.fixture.test/1" ? { ...row, relevance: 1 } : row,
      ),
      true,
    );
    expect(after).not.toBe(before);
  });

  it("does not change when the rows arrive in a different order", () => {
    expect(qrelsFingerprint([...rows].reverse(), true)).toBe(qrelsFingerprint(rows, true));
  });

  it("changes when the completeness flag changes", () => {
    // Same grades, different question: recall is computable in one case and
    // not in the other, so these must not share an identity.
    expect(qrelsFingerprint(rows, false)).not.toBe(qrelsFingerprint(rows, true));
  });

  it("is null when there is nothing to describe", () => {
    expect(qrelsFingerprint([], false)).toBeNull();
  });
});

describe("modelFingerprint", () => {
  it("is null when no model took part", () => {
    expect(modelFingerprint([])).toBeNull();
  });

  it("describes the participating model", () => {
    const digest = modelFingerprint([
      { id: "m1", kind: "rerank", providerType: "cohere", baseUrl: "https://api.cohere.ai", modelId: "rerank-3" },
    ]);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(
      modelFingerprint([
        { id: "m1", kind: "rerank", providerType: "cohere", baseUrl: "https://api.cohere.ai", modelId: "rerank-3" },
      ]),
    ).toBe(digest);
  });
});

describe("shortFingerprint", () => {
  it("truncates for display without inventing a value", () => {
    expect(shortFingerprint("0123456789abcdef0123456789abcdef")).toBe("01234567");
    expect(shortFingerprint(null)).toBeNull();
    expect(shortFingerprint("")).toBeNull();
  });
});
