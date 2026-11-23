import { withBackupLock } from "./lock.js";
import { verifyBackupPackage } from "./package.js";
import { verifyLegacyDatabase, type VerifyDatabaseBackupOptions } from "./sqlite.js";
import type { BackupVerificationReport } from "./types.js";

/** Unified verifier for complete `.shbackup` packages and honest legacy DB reports. */
export async function verifyDatabaseBackup(options: VerifyDatabaseBackupOptions): Promise<BackupVerificationReport> {
  if (options.path.toLowerCase().endsWith(".shbackup")) {
    return verifyBackupPackage({
      ...options,
      knownMigrations: options.knownMigrations,
      openDatabase: options.openDatabase,
    });
  }
  return withBackupLock(options.path, () => verifyLegacyDatabase(options));
}
