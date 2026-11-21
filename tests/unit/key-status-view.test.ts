import { describe, expect, it } from "vitest";
import { keyStatusTones } from "../../apps/web/src/lib/key-status.js";
import { en } from "../../apps/web/src/lib/i18n-en.js";
import { zh } from "../../apps/web/src/lib/i18n-zh.js";
import type { KeyStatus } from "../../apps/web/src/lib/types.js";

describe("quota_exhausted key status", () => {
  it("has a localized label and warning tone instead of a raw message key", () => {
    const status: KeyStatus = "quota_exhausted";
    expect(keyStatusTones[status]).toBe("warning");
    expect(zh[`keyStatus.${status}`]).toBe("额度耗尽");
    expect(en[`keyStatus.${status}`]).toBe("Quota exhausted");
    expect(zh[`keyStatus.${status}`]).not.toBe(`keyStatus.${status}`);
    expect(en[`keyStatus.${status}`]).not.toBe(`keyStatus.${status}`);
  });
});
