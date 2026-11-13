import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface SetupTokenState {
  value: string | null;
  source: "env" | "generated" | "none";
  filePath: string;
}

/**
 * First-run setup token.
 *
 * Goal: whoever reaches a fresh instance first must not be able to claim the
 * administrator account. When `SEARCH_HUB_SETUP_TOKEN` is not provided we
 * generate a random one and persist it with 0600 permissions next to the
 * database. The value is printed once at startup so the operator can read it
 * from `docker compose logs` or the file.
 *
 * `none` is only returned when the instance is already initialized.
 */
export function ensureSetupToken(
  dataDir: string,
  envToken: string | null,
  initialized: boolean,
): SetupTokenState {
  const filePath = join(dataDir, "setup-token");
  if (initialized) return { value: null, source: "none", filePath };
  if (envToken) return { value: envToken, source: "env", filePath };

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length >= 16) return { value: existing, source: "generated", filePath };
  }

  const value = randomBytes(18).toString("base64url");
  writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows has no POSIX mode; the file is created with the mode above.
  }
  return { value, source: "generated", filePath };
}

/** Removes the generated token file once an administrator exists. */
export function clearGeneratedSetupToken(state: SetupTokenState): void {
  if (state.source !== "generated") return;
  try {
    rmSync(state.filePath, { force: true });
  } catch {
    // Best effort: a leftover token is useless once setup is closed.
  }
}

/** Constant-time comparison that is safe for different-length inputs. */
export function setupTokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}
