import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SearchHubError } from "@search-hub/shared";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

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
    if (envKey && envKey.trim()) {
      const parsed = SecretBox.parseHexKey(envKey.trim());
      return new SecretBox(parsed, "env");
    }
    mkdirSync(dataDir, { recursive: true });
    const keyPath = join(dataDir, "master.key");
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, "utf8").trim();
      return new SecretBox(SecretBox.parseHexKey(raw), "file");
    }
    const generated = randomBytes(KEY_BYTES).toString("hex");
    writeFileSync(keyPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Windows does not support POSIX modes; the file is still created 0600-equivalent via mode above.
    }
    return new SecretBox(Buffer.from(generated, "hex"), "file");
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

export function sha256Hex(value: string): string {
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
