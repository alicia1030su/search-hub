import { createHash, createHmac } from "node:crypto";

/**
 * Tencent Cloud API 3.0 signature (TC3-HMAC-SHA256).
 *
 * Reference: https://cloud.tencent.com/document/api/213/30654
 * The canonical request is built over the exact headers that are signed; the
 * caller must send the same `content-type`, `host` and `x-tc-action` values.
 */
export interface Tc3Input {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  payload: string;
  /** Unix seconds. Injectable so tests are deterministic. */
  timestamp?: number;
}

export interface Tc3Headers {
  authorization: string;
  "content-type": string;
  host: string;
  "x-tc-action": string;
  "x-tc-timestamp": string;
  "x-tc-version": string;
}

const ALGORITHM = "TC3-HMAC-SHA256";
const CONTENT_TYPE = "application/json; charset=utf-8";

export function tc3SignedHeaders(input: Tc3Input): Tc3Headers {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaderNames = ["content-type", "host", "x-tc-action"];
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:${input.host}\n` +
    `x-tc-action:${input.action.toLowerCase()}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const hashedPayload = createHash("sha256").update(input.payload, "utf8").digest("hex");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join("\n");

  const credentialScope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    ALGORITHM,
    String(timestamp),
    credentialScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");

  return {
    authorization:
      `${ALGORITHM} Credential=${input.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": CONTENT_TYPE,
    host: input.host,
    "x-tc-action": input.action,
    "x-tc-timestamp": String(timestamp),
    "x-tc-version": input.version,
  };
}

function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/**
 * Tencent credentials are a pair. The key scheduler rotates one opaque string,
 * so the pair is stored as JSON in that string — rotation is always atomic and
 * two unrelated halves can never be combined.
 */
export function parseTencentCredential(
  raw: string | undefined,
): { secretId: string; secretKey: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { secretId?: unknown; secretKey?: unknown };
    if (typeof parsed.secretId === "string" && typeof parsed.secretKey === "string") {
      const secretId = parsed.secretId.trim();
      const secretKey = parsed.secretKey.trim();
      if (secretId && secretKey) return { secretId, secretKey };
    }
  } catch {
    // Fall through to the delimited form.
  }
  const separator = raw.includes("|") ? "|" : raw.includes("\n") ? "\n" : null;
  if (!separator) return null;
  const [secretId, secretKey] = raw.split(separator).map((part) => part.trim());
  return secretId && secretKey ? { secretId, secretKey } : null;
}
