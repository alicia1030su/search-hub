import { BACKUP_MEMBERS, type BackupMemberName } from "./types.js";

const BLOCK_BYTES = 512;

export interface StrictTarEntry { name: BackupMemberName; size: number; body: AsyncIterable<Uint8Array> }
export interface StrictTarLimits { maxArchiveBytes: number; maxManifestBytes: number; maxDatabaseBytes: number; maxMasterKeyBytes: number }

function memberLimit(name: BackupMemberName, limits: StrictTarLimits): number {
  if (name === "manifest.json") return limits.maxManifestBytes;
  if (name === "data/search-hub.db") return limits.maxDatabaseBytes;
  return limits.maxMasterKeyBytes;
}
function parseOctal(field: Buffer): number {
  if (field.every((byte) => byte === 0 || byte === 0x20)) return 0;
  const text = field.toString("latin1").replace(/^[\0 ]+|[\0 ]+$/g, "");
  if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Tar numeric field is out of range");
  return value;
}
function nulField(field: Buffer, label: string): string {
  const terminator = field.indexOf(0);
  if (terminator >= 0 && field.subarray(terminator).some((byte) => byte !== 0)) throw new Error(`Tar ${label} contains hidden data after NUL`);
  return field.subarray(0, terminator >= 0 ? terminator : field.length).toString("utf8");
}
function validatePath(name: string): void {
  if (!name || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.startsWith("//")) throw new Error("Absolute, drive and UNC archive paths are forbidden");
  if (name.includes("\\") || name.includes(":")) throw new Error("Backslash, drive and ADS archive paths are forbidden");
  if (name.includes("//") || name.includes("/./") || name.split("/").includes("..")) throw new Error("Archive path traversal is forbidden");
  if (Array.from(name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || "*?\"<>|".includes(character);
  })) throw new Error("Archive path contains a forbidden character");
}
function validateHeader(header: Buffer, expected: BackupMemberName): { name: BackupMemberName; size: number } {
  if (header.subarray(257, 263).toString("latin1") !== "ustar\0" || header.subarray(263, 265).toString("latin1") !== "00") throw new Error("Only canonical POSIX ustar headers are allowed");
  const type = header[156];
  if (type !== 0x30 && type !== 0x00) throw new Error("Links, directories, PAX/GNU metadata, devices and FIFOs are forbidden");
  const name = [nulField(header.subarray(345, 500), "prefix"), nulField(header.subarray(0, 100), "name")].filter(Boolean).join("/");
  validatePath(name);
  if (name !== expected) throw new Error(`Archive members must follow the fixed order; expected ${expected}`);
  if (parseOctal(header.subarray(100, 108)) !== 0o600) throw new Error("Tar member mode must be exactly 0600");
  if (parseOctal(header.subarray(108, 116)) !== 0 || parseOctal(header.subarray(116, 124)) !== 0) throw new Error("Tar member uid and gid must both be zero");
  if (parseOctal(header.subarray(329, 337)) !== 0 || parseOctal(header.subarray(337, 345)) !== 0) throw new Error("Tar device fields must be zero");
  if (header.subarray(157, 257).some((byte) => byte !== 0) || header.subarray(265, 329).some((byte) => byte !== 0)) throw new Error("Tar link/uname/gname fields must be empty");
  const expectedChecksum = parseOctal(header.subarray(148, 156));
  const checksumHeader = Buffer.from(header); checksumHeader.fill(0x20, 148, 156);
  if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum) throw new Error("Tar header checksum mismatch");
  const size = parseOctal(header.subarray(124, 136));
  return { name: name as BackupMemberName, size };
}

class BoundedTarReader {
  private buffered = Buffer.alloc(0);
  private consumed = 0;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly maxBytes: number) {}
  async read(maxBytes: number): Promise<Buffer | null> {
    while (this.buffered.length === 0) {
      const result = await this.reader.read();
      if (result.done) return null;
      this.buffered = Buffer.from(result.value);
      if (this.buffered.length === 0) continue;
    }
    if (this.consumed + this.buffered.length > this.maxBytes) throw new Error("Backup plaintext exceeds the configured archive limit");
    const output = this.buffered.subarray(0, Math.min(maxBytes, this.buffered.length));
    this.buffered = this.buffered.subarray(output.length);
    this.consumed += output.length;
    return output;
  }
  async exact(bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let remaining = bytes;
    while (remaining > 0) {
      const chunk = await this.read(remaining);
      if (chunk === null) throw new Error("Truncated tar archive");
      chunks.push(chunk); remaining -= chunk.length;
    }
    return Buffer.concat(chunks);
  }
}
async function consumeZeros(reader: BoundedTarReader, count: number): Promise<void> {
  const chunk = await reader.exact(count);
  if (chunk.some((byte) => byte !== 0)) throw new Error("Tar padding/end marker contains non-zero data");
}
async function* entryBody(reader: BoundedTarReader, size: number, name: BackupMemberName, limits: StrictTarLimits): AsyncGenerator<Uint8Array> {
  if (size > memberLimit(name, limits)) throw new Error(`Archive member exceeds its byte limit: ${name}`);
  let remaining = size;
  while (remaining > 0) {
    const chunk = await reader.read(Math.min(remaining, 64 * 1024));
    if (chunk === null) throw new Error(`Truncated archive member: ${name}`);
    remaining -= chunk.length; yield chunk;
  }
  const padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
  if (padding > 0) await consumeZeros(reader, padding);
}

/** Streaming strict parser for exactly three ordered, canonical regular files. */
export async function* readStrictTar(stream: ReadableStream<Uint8Array>, limits: StrictTarLimits): AsyncGenerator<StrictTarEntry> {
  const reader = stream.getReader();
  const bounded = new BoundedTarReader(reader, limits.maxArchiveBytes);
  try {
    for (const expected of BACKUP_MEMBERS) {
      const header = await bounded.exact(BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) throw new Error("Tar archive ended before all required members");
      const { name, size } = validateHeader(header, expected);
      yield { name, size, body: entryBody(bounded, size, name, limits) };
    }
    const firstEnd = await bounded.exact(BLOCK_BYTES);
    const secondEnd = await bounded.exact(BLOCK_BYTES);
    if (!firstEnd.every((byte) => byte === 0) || !secondEnd.every((byte) => byte === 0)) throw new Error("Tar archive requires two zero end blocks");
    if (await bounded.read(1) !== null) throw new Error("Unexpected data after the two tar end blocks");
  } finally {
    reader.releaseLock();
  }
}

export const DEFAULT_TAR_LIMITS: StrictTarLimits = {
  maxArchiveBytes: 16 * 1024 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxDatabaseBytes: 12 * 1024 * 1024 * 1024,
  maxMasterKeyBytes: 1024,
};
