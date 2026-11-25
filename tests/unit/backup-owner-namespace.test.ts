import { describe, expect, it } from "vitest";
import { uploadOwnerNamespace } from "../../apps/api/src/services/backup.js";

describe("upload owner namespace", () => {
  it("preserves path case on case-sensitive platforms", () => {
    expect(uploadOwnerNamespace("/data/Foo", "linux")).not.toBe(uploadOwnerNamespace("/data/foo", "linux"));
    expect(uploadOwnerNamespace("/data/Foo", "darwin")).not.toBe(uploadOwnerNamespace("/data/foo", "darwin"));
  });

  it("normalizes path case on Windows", () => {
    expect(uploadOwnerNamespace("/data/Foo", "win32")).toBe(uploadOwnerNamespace("/data/foo", "win32"));
  });
});
