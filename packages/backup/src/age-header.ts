import { createReadStream } from "node:fs";

export const DEFAULT_SCRYPT_WORK_FACTOR = 18;
export const MAX_AGE_HEADER_BYTES = 64 * 1024;

export interface AgeHeaderInfo { workFactor: number; headerBytes: number; salt: Buffer }

function decodeRawBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+$/.test(value)) throw new Error(`Invalid age ${label} base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value) throw new Error(`Non-canonical age ${label} base64`);
  return decoded;
}

/** Strictly parses only the bounded ASCII age header; payload stays streaming. */
export async function readAgeHeader(path: string): Promise<AgeHeaderInfo> {
  const stream = createReadStream(path, { highWaterMark: 4096 });
  const chunks: Buffer[] = [];
  let length = 0;
  let header: Buffer | undefined;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      chunks.push(chunk); length += chunk.length;
      if (length > MAX_AGE_HEADER_BYTES) throw new Error("age header exceeds the 64 KiB safety limit");
      const candidate = Buffer.concat(chunks);
      const text = candidate.toString("ascii");
      const match = /(?:^|\n)--- [A-Za-z0-9+/]+\n/.exec(text);
      if (match && match.index !== undefined) {
        const end = match.index + match[0].length;
        header = candidate.subarray(0, end);
        if (header.some((byte) => byte > 0x7f || byte === 0)) throw new Error("age header must contain ASCII text only");
        break;
      }
      if (candidate.some((byte) => byte > 0x7f || byte === 0)) throw new Error("age header must contain ASCII text only");
    }
  } finally {
    stream.destroy();
  }
  if (!header) throw new Error("Truncated age header or incomplete MAC line");
  const text = header.toString("ascii");
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length !== 4 || lines[0] !== "age-encryption.org/v1") throw new Error("Not a canonical age v1 passphrase header");
  const stanzas = lines.filter((line) => line.startsWith("-> "));
  if (stanzas.length !== 1 || lines.filter((line) => line.startsWith("->")).length !== 1) throw new Error("Backup packages must contain exactly one passphrase recipient");
  const parts = (stanzas[0] ?? "").split(" ");
  if (parts.length !== 4 || parts[0] !== "->" || parts[1] !== "scrypt" || !/^\d+$/.test(parts[3] ?? "")) throw new Error("Invalid age scrypt stanza");
  const salt = decodeRawBase64(parts[2] ?? "", "salt");
  if (salt.length !== 16) throw new Error("age scrypt salt must be exactly 16 bytes");
  const body = decodeRawBase64(lines[2] ?? "", "body");
  if (body.length !== 32) throw new Error("age scrypt body must be exactly 32 bytes");
  const macLine = lines[3] ?? "";
  if (!macLine.startsWith("--- ")) throw new Error("age MAC line must use exactly one ASCII space");
  const macText = macLine.slice(4);
  if (decodeRawBase64(macText, "MAC").length !== 32) throw new Error("age MAC must be exactly 32 bytes");
  const workFactor = Number(parts[3]);
  if (!Number.isSafeInteger(workFactor) || workFactor < 1 || workFactor > 30) throw new Error("age scrypt work factor is out of range");
  return { workFactor, headerBytes: header.length, salt };
}

export async function assertDefaultAgeWorkFactor(path: string): Promise<AgeHeaderInfo> {
  const header = await readAgeHeader(path);
  if (header.workFactor !== DEFAULT_SCRYPT_WORK_FACTOR) throw new Error(`Backup passphrase work factor must be the secure default (${DEFAULT_SCRYPT_WORK_FACTOR})`);
  return header;
}
