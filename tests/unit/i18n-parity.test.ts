import { describe, expect, it } from "vitest";
import { en } from "../../apps/web/src/lib/i18n-en.js";
import { zh, type MessageKey } from "../../apps/web/src/lib/i18n-zh.js";

/**
 * Locale parity.
 *
 * A dictionary that is 90% translated looks complete until a user opens the page
 * that contains the missing 10%. These static checks make the gap a test failure
 * instead of a surprise:
 *
 *  1. every Chinese key has an English entry — enforced by the `Record<MessageKey,
 *     string>` type, asserted here as well so a `as any` cast cannot slip through
 *     CI;
 *  2. no English value contains CJK characters (a half-translated string);
 *  3. placeholders (`{{name}}`) match exactly, so a template cannot lose a variable;
 *  4. no value is empty.
 *
 * Runtime behaviour (switch, persistence, re-render) is covered by the browser
 * E2E test; this file covers the dictionary itself.
 */
describe("i18n parity", () => {
  const zhKeys = Object.keys(zh) as MessageKey[];
  const enKeys = Object.keys(en) as MessageKey[];

  it("covers every Chinese key in English", () => {
    const missing = zhKeys.filter((key) => !(key in en));
    expect(missing, `missing English keys: ${missing.slice(0, 10).join(", ")}`).toEqual([]);
    expect(enKeys.length).toBe(zhKeys.length);
  });

  it("has no Chinese characters left in the English dictionary", () => {
    // CJK Unified Ideographs + CJK punctuation + fullwidth forms.
    const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
    const offenders = zhKeys.filter((key) => cjk.test(en[key]));
    expect(offenders, `English values still containing CJK: ${offenders.slice(0, 10).join(", ")}`).toEqual([]);
  });

  it("keeps every placeholder identical to the Chinese template", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const mismatched = zhKeys.filter((key) => {
      const zhVars = placeholders(zh[key]);
      const enVars = placeholders(en[key]);
      return zhVars.join(",") !== enVars.join(",");
    });
    // A template that drops {{count}} renders "{{count}} entries" to the user.
    expect(mismatched, `placeholder mismatch: ${mismatched.slice(0, 10).join(", ")}`).toEqual([]);
  });

  it("has no empty values", () => {
    const empty = zhKeys.filter((key) => en[key].trim().length === 0 || zh[key].trim().length === 0);
    expect(empty).toEqual([]);
  });

  it("keeps dates and numbers locale-aware instead of hardcoded zh-CN", () => {
    // The formatter module must consult `getLocale()`; a module-level
    // `Intl.DateTimeFormat("zh-CN")` would keep Chinese date order in an English
    // page. This is a source check because the behaviour itself is exercised in
    // the browser, where `Intl` works for real.
    const source = readFormatSource();
    const hardcoded = source.match(/Intl\.(DateTimeFormat|NumberFormat)\(\s*"zh-CN"/g) ?? [];
    expect(hardcoded, `hardcoded zh-CN formatters: ${hardcoded.join(", ")}`).toEqual([]);
  });
});

function readFormatSource(): string {
  // Imported lazily so a failure points at the assertion above rather than at
  // module resolution during collection.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(
    require("node:path").join(process.cwd(), "apps", "web", "src", "lib", "format.ts"),
    "utf8",
  ) as string;
}
