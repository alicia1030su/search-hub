import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM packaging module
import { classifyReleaseLookup, releaseReleasesApiPath, resolveReleaseDraft } from "../../packaging/check-release-draft.mjs";

function success(value: unknown, tag = "v0.1.15") {
  return classifyReleaseLookup({ exitCode: 0, stdout: JSON.stringify(value), tag });
}

function release(assets: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return { tag_name: "v0.1.15", draft: true, prerelease: false, assets, ...overrides };
}

const uploadedAssets = Array.from({ length: 9 }, (_, index) => ({ name: `asset-${index}`, state: "uploaded" }));

describe("release draft lookup", () => {
  it("lists releases and finds the exact tag across paginated responses", () => {
    expect(releaseReleasesApiPath("alicia1030su/search-hub")).toBe("repos/alicia1030su/search-hub/releases");
    const tag = "release/候选 #1";
    const lookup = success([[release([], { tag_name: "other" })], [release(uploadedAssets, { tag_name: tag })]], tag);
    expect(lookup).toMatchObject({ kind: "success", release: { tag_name: tag } });
    expect(success([release()], "missing")).toEqual({ kind: "not-found" });
  });

  it("allows push to create a missing release or reuse an empty private draft", () => {
    expect(resolveReleaseDraft(success([]), "push")).toEqual({ action: "create", assets: 0 });
    expect(resolveReleaseDraft(success(release()), "push")).toEqual({ action: "create", assets: 0 });
  });

  it("allows dispatch to reuse only the existing nine-asset private draft", () => {
    expect(resolveReleaseDraft(success(release(uploadedAssets)), "workflow_dispatch")).toEqual({ action: "reuse", assets: 9 });
    expect(() => resolveReleaseDraft(success([]), "workflow_dispatch")).toThrow(/release_draft_not_found_for_dispatch/);
  });

  it("fails closed on server and authentication errors", () => {
    for (const stderr of ["gh: HTTP 404: Not Found", "gh: HTTP 502: Bad Gateway", "gh: HTTP 401: Bad credentials", "dial tcp: lookup api.github.com: no such host"]) {
      const lookup = classifyReleaseLookup({ exitCode: 1, stderr });
      expect(lookup.kind).toBe("error");
      expect(() => resolveReleaseDraft(lookup, "push")).toThrow(/release_lookup_failed/);
      expect(() => resolveReleaseDraft(lookup, "workflow_dispatch")).toThrow(/release_lookup_failed/);
    }
  });

  it("rejects published or prerelease releases", () => {
    expect(() => resolveReleaseDraft(success(release([], { draft: false })), "workflow_dispatch")).toThrow(/release_draft_invalid/);
    expect(() => resolveReleaseDraft(success(release(uploadedAssets, { prerelease: true })), "workflow_dispatch")).toThrow(/release_draft_invalid/);
  });

  it("rejects a non-empty push draft and wrong dispatch asset counts", () => {
    expect(() => resolveReleaseDraft(success(release([{ state: "uploaded" }])), "push")).toThrow(/release_push_draft_not_empty/);
    for (const count of [0, 8, 10]) {
      expect(() => resolveReleaseDraft(success(release(Array.from({ length: count }, () => ({ state: "uploaded" })))), "workflow_dispatch")).toThrow(/release_dispatch_draft_assets_invalid/);
    }
  });

  it("rejects dispatch assets that are not fully uploaded", () => {
    const assets = uploadedAssets.map((asset) => ({ ...asset }));
    assets[3] = { ...assets[3]!, state: "starter" };
    expect(() => resolveReleaseDraft(success(release(assets)), "workflow_dispatch")).toThrow(/release_dispatch_draft_assets_invalid/);
  });

  it("rejects ambiguous duplicate tag matches", () => {
    const lookup = success([release(), release()]);
    expect(lookup).toEqual({ kind: "error", message: "release_tag_ambiguous" });
    expect(() => resolveReleaseDraft(lookup, "push")).toThrow(/release_tag_ambiguous/);
    expect(() => resolveReleaseDraft(lookup, "workflow_dispatch")).toThrow(/release_tag_ambiguous/);
  });

  it("treats malformed success JSON as an error", () => {
    const lookup = classifyReleaseLookup({ exitCode: 0, stdout: "not-json" });
    expect(lookup.kind).toBe("error");
    expect(() => resolveReleaseDraft(lookup, "push")).toThrow(/release_lookup_failed/);
  });
});
