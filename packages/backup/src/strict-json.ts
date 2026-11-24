/** Bounded JSON parser that rejects duplicate object keys instead of overwriting them. */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const fail = (message: string): never => { throw new Error(`Invalid manifest JSON: ${message}`); };
  const whitespace = (): void => {
    while (index < text.length && /[\x20\t\r\n]/.test(text[index] as string)) index += 1;
  };
  const string = (): string => {
    const start = index;
    if (text[index] !== '"') fail("expected string");
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      if (character === "\\") {
        index += 2;
        continue;
      }
      if ((character?.charCodeAt(0) ?? 0) < 0x20) fail("unescaped control character");
      index += 1;
    }
    return fail("unterminated string");
  };
  const value = (depth: number): unknown => {
    if (depth > 32) fail("nesting is too deep");
    whitespace();
    const character = text[index];
    if (character === '"') return string();
    if (character === "{") {
      index += 1;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      whitespace();
      if (text[index] === "}") { index += 1; return result; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail("expected colon");
        index += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (text[index] === "}") { index += 1; return result; }
        if (text[index] !== ",") fail("expected comma or closing brace");
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      const result: unknown[] = [];
      whitespace();
      if (text[index] === "]") { index += 1; return result; }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        if (text[index] === "]") { index += 1; return result; }
        if (text[index] !== ",") fail("expected comma or closing bracket");
        index += 1;
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) fail("number is not finite");
      return parsed;
    }
    return fail("unexpected token");
  };
  const result = value(0);
  whitespace();
  if (index !== text.length) fail("trailing data");
  return result;
}
