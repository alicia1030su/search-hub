import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./hash.js";
import { readSmallTextFile } from "./private-fs.js";
import type { KeyProof } from "./types.js";

const FINGERPRINT_DOMAIN = "search-hub-master-key-fingerprint-v1\0";
const PROOF_DOMAIN = "search-hub-master-key-proof-v1";

export interface MasterKeyDescription {
  source: "env" | "file";
  fingerprint: string;
}

export interface EncryptedSample {
  ciphertext: string;
  iv: string;
  tag: string;
  version?: number;
}

/** Parses the canonical 32-byte hexadecimal master key format. */
export function parseMasterKey(value: string | Buffer): Buffer {
  const raw = typeof value === "string" ? value.trim() : value;
  if (typeof raw === "string") {
    if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error("Master key must be exactly 64 hexadecimal characters");
    return Buffer.from(raw, "hex");
  }
  if (raw.length !== 32) throw new Error("Master key must be exactly 32 bytes");
  return Buffer.from(raw);
}

/** Domain-separated fingerprint; the raw key is never exposed by this value. */
export function masterKeyFingerprint(value: string | Buffer): string {
  return sha256(Buffer.concat([Buffer.from(FINGERPRINT_DOMAIN, "utf8"), parseMasterKey(value)]));
}

/** Reads a bounded, regular, non-inherited 0600 master-key file. */
export async function readMasterKey(path: string): Promise<Buffer> {
  return parseMasterKey(await readSmallTextFile(path, 1024));
}

function proofAad(packageId: string, fingerprint: string): Buffer {
  return Buffer.from(`${PROOF_DOMAIN}\0${packageId}\0${fingerprint}`, "utf8");
}

export function createKeyProof(key: Buffer, packageId: string, fingerprint: string): KeyProof {
  const iv = randomBytes(12);
  const plaintext = Buffer.concat([Buffer.from(`${PROOF_DOMAIN}\0`, "utf8"), randomBytes(32)]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(proofAad(packageId, fingerprint));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function verifyKeyProof(key: Buffer, proof: KeyProof, packageId: string, fingerprint: string): boolean {
  try {
    if (proof.version !== 1 || proof.algorithm !== "aes-256-gcm") return false;
    const iv = Buffer.from(proof.iv, "base64");
    const tag = Buffer.from(proof.tag, "base64");
    const ciphertext = Buffer.from(proof.ciphertext, "base64");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== Buffer.byteLength(PROOF_DOMAIN) + 1 + 32) return false;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(proofAad(packageId, fingerprint));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.subarray(0, Buffer.byteLength(PROOF_DOMAIN) + 1).equals(Buffer.from(`${PROOF_DOMAIN}\0`, "utf8"));
  } catch {
    return false;
  }
}

/** Decrypts one AES-256-GCM sample without returning or logging plaintext. */
export function decryptSample(key: Buffer, sample: EncryptedSample): boolean {
  if ((sample.version ?? 1) !== 1) return false;
  try {
    const iv = Buffer.from(sample.iv, "base64");
    const tag = Buffer.from(sample.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) return false;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    decipher.update(Buffer.from(sample.ciphertext, "base64"));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

export function describeMasterKey(key: Buffer, source: MasterKeyDescription["source"]): MasterKeyDescription {
  return { source, fingerprint: masterKeyFingerprint(key) };
}

export function safeKeyEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
