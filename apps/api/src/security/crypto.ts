import { restrictWindowsAclSync } from "@search-hub/backup";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SearchHubError } from "@search-hub/shared";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function restrictMasterKeyPermissions(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function restrictDataDirPermissions(path: string): void {
  if (process.platform === "win32") restrictWindowsAclSync(path, true);
  else chmodSync(path, 0o700);
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  version: number;
}

/**
 * AES-256-GCM secret box.
 *
 * Master key resolution order:
 *  1. SEARCH_HUB_ENCRYPTION_KEY (64 hex chars = 32 bytes)
 *  2. <dataDir>/master.key, generated with 0600 permissions on first start
 *
 * The generated file is a real secret: it must be backed up together with the
 * database, otherwise stored API keys become unrecoverable. This is documented
 * in SECURITY.md and the deployment guide.
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly keySource: "env" | "file";

  private constructor(key: Buffer, source: "env" | "file") {
    this.key = key;
    this.keySource = source;
  }

  static fromEnvOrFile(dataDir: string, envKey?: string): SecretBox {
    if (envKey !== undefined) {
      // A configured environment key is authoritative. Blank/invalid values fail
      // closed instead of silently falling back to an unrelated on-disk key.
      const parsed = SecretBox.parseHexKey(envKey.trim());
      return new SecretBox(parsed, "env");
    }
    mkdirSync(dataDir, { recursive: true });
    restrictDataDirPermissions(dataDir);
    const keyPath = join(dataDir, "master.key");
    let generated: string | null = null;
    if (!existsSync(keyPath)) {
      const candidate = randomBytes(KEY_BYTES).toString("hex");
      const temporary = `${keyPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, "wx", 0o600);
        writeFileSync(descriptor, `${candidate}\n`, { encoding: "utf8" });
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        restrictMasterKeyPermissions(temporary);
        // Publish only complete, synced bytes. link() fails atomically if another
        // first start already won, so no process observes a partial key.
        linkSync(temporary, keyPath);
        generated = candidate;
        fsyncDirectory(dataDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporary); } catch { /* already absent */ }
      }
    }
    // An EEXIST race means another process published the authoritative key. Read
    // that file; never substitute the losing random candidate.
    const raw = generated ?? readFileSync(keyPath, "utf8").trim();
    restrictMasterKeyPermissions(keyPath);
    return new SecretBox(SecretBox.parseHexKey(raw), "file");
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) {
      throw new SearchHubError("internal_error", "Encryption key must be 32 bytes");
    }
    return new SecretBox(key, "file");
  }

  private static parseHexKey(raw: string): Buffer {
    if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
      throw new SearchHubError(
        "internal_error",
        "SEARCH_HUB_ENCRYPTION_KEY must be 64 hex characters (32 bytes). " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    return Buffer.from(raw, "hex");
  }

  get source(): "env" | "file" {
    return this.keySource;
  }

  /** Non-reversible fingerprint used to detect a changed master key. */
  fingerprint(): string {
    return sha256Hex(this.key);
  }

  /** Server-internal copy for encrypted recovery packages; never serialized by itself. */
  recoveryKey(): Buffer {
    return Buffer.from(this.key);
  }

  encrypt(plaintext: string, version = 1): EncryptedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      version,
    };
  }

  decrypt(secret: EncryptedSecret): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(secret.iv, "base64"));
      decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch (error) {
      throw new SearchHubError(
        "internal_error",
        "Failed to decrypt a stored secret. The encryption master key may have changed.",
        { cause: error },
      );
    }
  }

  /**
   * Stable hint for the UI: first 4 + last 4 characters (AC-03).
   * Never enough to reconstruct the key, but enough for an operator to tell
   * two keys apart. Short values collapse to a fixed mask.
   */
  hint(plaintext: string): string {
    const trimmed = plaintext.trim();
    if (trimmed.length <= 12) return "••••";
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  }
}

/** scrypt password hashing with a per-user salt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix: string, bytes = 32): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(bytes).toString("base64url");
  const token = `${prefix}${raw}`;
  return { token, hash: sha256Hex(token), prefix };
}

/** CSRF-safe opaque session token; the DB stores only its hash. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function resolveDataDir(configured?: string): string {
  const dir = configured ?? process.env["SEARCH_HUB_DATA_DIR"] ?? join(process.cwd(), "data");
  ensureDir(dir);
  return dir;
}

export function resolveDbPath(dataDir: string, configured?: string): string {
  return configured ?? process.env["SEARCH_HUB_DB_PATH"] ?? join(dataDir, "search-hub.db");
}

export function parentDir(path: string): string {
  return dirname(path);
}
