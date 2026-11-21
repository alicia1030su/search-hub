import { describe, expect, it } from "vitest";
import { keyCreateSchema, keyUpdateSchema } from "@search-hub/shared";

const schemas = [
  { name: "keyCreateSchema", schema: keyCreateSchema, payload: { label: "primary" } },
  { name: "keyUpdateSchema", schema: keyUpdateSchema, payload: {} },
] as const;

describe.each(schemas)("$name key length", ({ schema, payload }) => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])("rejects a %i-character key", (length) => {
    const result = schema.safeParse({ ...payload, key: "x".repeat(length) });
    expect(result.success, JSON.stringify(result)).toBe(false);
  });

  it.each([8, 9, 64, 8192])("accepts a %i-character key", (length) => {
    const key = "x".repeat(length);
    const result = schema.safeParse({ ...payload, key });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) expect(result.data.key).toBe(key);
  });

  it("measures length after trimming surrounding whitespace", () => {
    expect(schema.safeParse({ ...payload, key: " 1234567 " }).success).toBe(false);
    expect(schema.safeParse({ ...payload, key: " 12345678 " }).success).toBe(true);
  });
});
