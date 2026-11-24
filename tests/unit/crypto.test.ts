import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SecretBox,
  hashPassword,
  newSessionToken,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "../../apps/api/src/security/crypto.js";

describe("SecretBox (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const box = SecretBox.fromKey(Buffer.alloc(32, 7));
    const encrypted = box.encrypt("sk-super-secret-value");
    expect(encrypted.ciphertext).not.toContain("sk-super");
    expect(box.decrypt(encrypted)).toBe("sk-super-secret-value");
  });

  it("uses a fresh IV for every encryption", () => {
    const box = SecretBox.fromKey(Buffer.alloc(32, 7));
    const a = box.encrypt("same plaintext");
    const b = box.encrypt("same plaintext");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects a tampered ciphertext", () => {
    const box = SecretBox.fromKey(Buffer.alloc(32, 7));
    const encrypted = box.encrypt("secret");
    const tampered = Buffer.from(encrypted.ciphertext, "base64");
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => box.decrypt({ ...encrypted, ciphertext: tampered.toString("base64") })).toThrow(
      /decrypt/i,
    );
  });

  it("cannot decrypt with a different master key", () => {
    const a = SecretBox.fromKey(Buffer.alloc(32, 1));
    const b = SecretBox.fromKey(Buffer.alloc(32, 2));
    const encrypted = a.encrypt("secret");
    expect(() => b.decrypt(encrypted)).toThrow(/master key/i);
  });

  it("generates and persists a 0600-equivalent master key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-key-"));
    try {
      const box = SecretBox.fromEnvOrFile(dir);
      expect(box.source).toBe("file");
      const raw = readFileSync(join(dir, "master.key"), "utf8").trim();
      expect(raw).toMatch(/^[a-f0-9]{64}$/);
      // Second open reuses the same key and can decrypt previous data.
      const encrypted = box.encrypt("persisted");
      const reopened = SecretBox.fromEnvOrFile(dir);
      expect(reopened.decrypt(encrypted)).toBe("persisted");
      const mode = statSync(join(dir, "master.key")).mode & 0o777;
      // Windows ignores POSIX modes; only assert on POSIX.
      if (process.platform !== "win32") expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one master key when first-start processes race", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-key-race-"));
    try {
      const script = join(dir, "race.mts");
      writeFileSync(script, `import { SecretBox } from ${JSON.stringify(new URL("../../apps/api/src/security/crypto.ts", import.meta.url).href)};\nconsole.log(SecretBox.fromEnvOrFile(${JSON.stringify(dir)}).fingerprint());\n`);
      const fingerprints = Array.from({ length: 4 }, () => execFileSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" }).trim());
      expect(new Set(fingerprints).size).toBe(1);
      expect(SecretBox.fromEnvOrFile(dir).fingerprint()).toBe(fingerprints[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid environment master key", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-key-bad-"));
    try {
      expect(() => SecretBox.fromEnvOrFile(dir, "too-short")).toThrow(/64 hex/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks secrets for UI display", () => {
    const box = SecretBox.fromKey(Buffer.alloc(32, 1));
    // AC-03: mask shows the first 4 and the last 4 characters.
    expect(box.hint("sk-1234567890abcd")).toBe("sk-1…abcd");
    expect(box.hint("short")).toBe("••••");
    expect(box.hint("123456789012")).toBe("••••"); // exactly 12 chars collapses
    expect(box.hint("sk-1234567890123")).toBe("sk-1…0123");
  });
});

describe("password hashing", () => {
  it("verifies the correct password and rejects others", () => {
    const hash = hashPassword("A-very-long-password-1");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("A-very-long-password-1", hash)).toBe(true);
    expect(verifyPassword("A-very-long-password-2", hash)).toBe(false);
  });

  it("uses a unique salt per password", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "plain-text")).toBe(false);
  });
});

describe("tokens", () => {
  it("generates prefixed tokens with a stable sha256 hash", () => {
    const token = randomToken("sh_", 32);
    expect(token.token.startsWith("sh_")).toBe(true);
    expect(token.hash).toBe(sha256Hex(token.token));
    expect(token.hash).toHaveLength(64);
  });

  it("generates distinct session tokens", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});
