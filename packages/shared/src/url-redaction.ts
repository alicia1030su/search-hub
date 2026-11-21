/** Query parameter names that commonly carry credentials. */
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "token",
  "key",
  "client_secret",
]);

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Match a key both literally and with common percent-encoded characters. */
function encodedKeyPattern(name: string): string {
  return [...name]
    .map((character) => {
      const literal = character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const encoded = encodeURIComponent(character)
        .split("")
        .map((part) => `%${part.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("");
      return encoded ? `(?:${literal}|${encoded})` : literal;
    })
    .join("");
}

const SENSITIVE_QUERY_PATTERN = new RegExp(
  `([?&])(${[...SENSITIVE_QUERY_KEYS].map(encodedKeyPattern).join("|")})=([^&#\\s"']*)`,
  "gi",
);

export function isSensitiveQueryKey(name: string): boolean {
  return SENSITIVE_QUERY_KEYS.has(decoded(name).trim().toLowerCase());
}

/** Credential values carried by a URL, decoded for exact-value redaction. */
export function sensitiveQueryValues(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    return [...url.searchParams.entries()]
      .filter(([key, value]) => isSensitiveQueryKey(key) && value.length > 0)
      .map(([, value]) => value);
  } catch {
    return [];
  }
}

/**
 * Redacts sensitive query values embedded in arbitrary upstream-controlled text.
 * Non-sensitive parameters remain intact so operators can still diagnose the
 * request (for example `engine`, `q`, `page` or `start`).
 */
export function redactSensitiveQueryParams(text: string): string {
  return text.replace(SENSITIVE_QUERY_PATTERN, (_match, separator: string, key: string) =>
    `${separator}${key}=[redacted]`,
  );
}

/** Returns a diagnostic URL with only credential-bearing query values removed. */
export function sanitizeUrl(rawUrl: string, secrets: string[] = []): string {
  const exact = new Set(secrets.filter(Boolean));
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of url.searchParams.entries()) {
      if (isSensitiveQueryKey(key) || [...exact].some((secret) => value.includes(secret))) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return redactSensitiveQueryParams(redactExactSecrets(rawUrl, secrets));
  }
}

interface TextToken {
  char: string;
  start: number;
  end: number;
}

function literalTokens(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    tokens.push({ char: character, start: offset, end });
    offset = end;
  }
  return tokens;
}

function isHex(token: TextToken | undefined): token is TextToken {
  return token !== undefined && /^[0-9a-f]$/i.test(token.char);
}

/**
 * Decodes one percent-encoding layer while retaining source spans. A valid Key
 * can be 8192 characters, so this intentionally avoids constructing a RegExp
 * from the credential: oversized patterns can throw, and the SyntaxError text
 * may itself contain the secret.
 */
function decodeTokens(tokens: TextToken[], plusAsSpace: boolean): TextToken[] {
  const output: TextToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (plusAsSpace && token.char === "+") {
      output.push({ ...token, char: " " });
      continue;
    }
    if (token.char !== "%") {
      output.push(token);
      continue;
    }
    let decoded: string | undefined;
    let consumed = 0;
    // UTF-8 needs at most four bytes for one code point. Trying increasing
    // lengths also keeps adjacent ASCII escapes as separate tokens.
    for (let bytes = 1; bytes <= 4 && index + bytes * 3 - 1 < tokens.length; bytes += 1) {
      const parts: string[] = [];
      let valid = true;
      for (let byte = 0; byte < bytes; byte += 1) {
        const current = tokens[index + byte * 3];
        const high = tokens[index + byte * 3 + 1];
        const low = tokens[index + byte * 3 + 2];
        if (current?.char !== "%" || !isHex(high) || !isHex(low)) {
          valid = false;
          break;
        }
        parts.push(`${current.char}${high.char}${low.char}`);
      }
      if (!valid) break;
      try {
        const candidate = decodeURIComponent(parts.join(""));
        if ([...candidate].length === 1) {
          decoded = candidate;
          consumed = bytes * 3;
          break;
        }
      } catch {
        // Invalid UTF-8 or a lone escape: keep the percent sign literal.
      }
    }
    if (decoded === undefined || consumed === 0) {
      output.push(token);
      continue;
    }
    output.push({
      // Only a raw query-form '+' means space. A decoded %2B is a literal plus
      // in the credential and must remain '+' for exact matching.
      char: decoded,
      start: token.start,
      end: tokens[index + consumed - 1]!.end,
    });
    index += consumed - 1;
  }
  return output;
}

function tokenView(tokens: TextToken[]): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (const token of tokens) {
    offsets.push(text.length);
    text += token.char;
  }
  return { text, offsets };
}

function tokenIndexAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle]! <= position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function secretIntervals(text: string, secret: string): Array<{ start: number; end: number }> {
  if (!secret) return [];
  const intervals: Array<{ start: number; end: number }> = [];
  // Raw plus three decoding layers cover literal, URI, query-form,
  // double-encoded and arbitrarily mixed echoes. The third layer is needed for
  // a double-encoded query-form space (`%252B` -> `%2B` -> `+` -> space).
  // Searching literal strings with indexOf cannot throw because of key length.
  for (let passes = 0; passes <= 3; passes += 1) {
    for (const plusAsSpace of [false, true]) {
      let tokens = literalTokens(text);
      // At each layer, only a pre-existing raw '+' is query-form space. A '+'
      // produced by decoding %2B is a literal credential character.
      for (let pass = 0; pass < passes; pass += 1) tokens = decodeTokens(tokens, plusAsSpace);
      if (passes === 0 && plusAsSpace) {
        tokens = tokens.map((token) => token.char === "+" ? { ...token, char: " " } : token);
      }
      const view = tokenView(tokens);
      let offset = view.text.indexOf(secret);
      while (offset !== -1) {
        const startToken = tokens[tokenIndexAt(view.offsets, offset)];
        const endToken = tokens[tokenIndexAt(view.offsets, offset + secret.length - 1)];
        if (startToken && endToken) intervals.push({ start: startToken.start, end: endToken.end });
        offset = view.text.indexOf(secret, offset + secret.length);
      }
    }
  }
  return intervals;
}

export function redactExactSecrets(text: string, secrets: string[]): string {
  const values = [...new Set(secrets.filter(Boolean).map((secret) => secret.replace(/^bearer\s+/i, "")))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return text;
  const intervals = values.flatMap((secret) => secretIntervals(text, secret));
  if (intervals.length === 0) return text;
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  let output = "";
  let cursor = 0;
  for (const interval of merged) {
    output += text.slice(cursor, interval.start) + "[redacted]";
    cursor = interval.end;
  }
  return output + text.slice(cursor);
}
