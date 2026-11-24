/** Public contracts for the Search Hub v1 disaster-recovery package. */
import type { SnapshotAdapter, SqliteHandleFactory } from "./sqlite.js";

export const BACKUP_FORMAT_VERSION = 1 as const;
export const BACKUP_FORMAT = "shbackup-v1" as const;
export const BACKUP_MEMBERS = ["manifest.json", "data/search-hub.db", "keys/master.key"] as const;
export type BackupMemberName = (typeof BACKUP_MEMBERS)[number];

export interface BackupLimits {
  maxArchiveBytes: number;
  maxManifestBytes: number;
  maxDatabaseBytes: number;
  maxMasterKeyBytes: number;
}

export interface KeyProof {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EmbeddedMigration {
  name: string;
  sql: string;
  sha256: string;
}

export interface EmbeddedSchemaContract {
  version: 1;
  requiredTables: Record<string, string[]>;
  migrations: EmbeddedMigration[];
}

export interface OriginGuard {
  algorithm: "sha256-prefix-v1";
  dataDir: string;
  installDir: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  packageId: string;
  createdAt: string;
  producer: { appVersion: string; commit: string };
  database: {
    path: "data/search-hub.db";
    bytes: number;
    sha256: string;
    schemaVersion: string | null;
    userVersion: number;
    migrations: string[];
    snapshotMethod: "sqlite_backup_api" | "vacuum_into" | "provided";
    journal: "delete";
  };
  key: { source: "env" | "file"; fingerprint: string };
  members: readonly BackupMemberName[];
  limits: BackupLimits;
  encryption: { format: "age-v1"; kdf: "scrypt"; aead: "ChaCha20-Poly1305"; workFactor: 18 };
  originGuard: OriginGuard;
  schemaContractVersion: 1;
  schemaContract: EmbeddedSchemaContract;
  keyProof: KeyProof;
}

export interface BackupPackageResult {
  path: string;
  bytes: number;
  sha256: string;
  manifest: BackupManifest;
  members: readonly BackupMemberName[];
  report: BackupVerificationReport;
}

export type KeyReadiness = "verified" | "unverified" | "missing" | "mismatch";

export interface BackupVerificationReport {
  format: typeof BACKUP_FORMAT | "legacy-db";
  formatOk: boolean;
  structuralOk: boolean;
  schemaCompatible: boolean;
  keyFingerprintMatch: boolean;
  ciphertextSampleDecryptable: boolean;
  restoreReadiness: boolean;
  keyReadiness: KeyReadiness;
  sampleCount: number;
  keyProofValid: boolean | null;
  sha256Match: boolean;
  bytes: number;
  dbBytes: number;
  dbSha256: string | null;
  schemaVersion: string | null;
  userVersion: number;
  migrations: string[];
  headerOk: boolean;
  integrity: "ok" | "failed";
  foreignKeys: "ok" | "failed";
  requiredSchema: "ok" | "failed";
  journalMode: string;
  reason?: string;
  checkedAt: string;
}

export interface CreateBackupPackageOptions {
  /** A previously sealed, consistent SQLite snapshot. */
  snapshotPath?: string;
  /** Preferred: the adapter creates and exposes a consistent private snapshot. */
  snapshotAdapter?: SnapshotAdapter;
  snapshotMethod?: BackupManifest["database"]["snapshotMethod"];
  masterKeyPath?: string;
  masterKeyValue?: string | Buffer;
  outputPath: string;
  passphrase: string;
  appVersion: string;
  commit?: string | null;
  migrations: string[];
  migrationSql?: Readonly<Record<string, string>>;
  keySource: "env" | "file";
  creator?: "api" | "cli" | "updater";
  dataDir?: string;
  installDir?: string;
  originGuard?: OriginGuard;
  openDatabase?: SqliteHandleFactory;
  limits?: Partial<BackupLimits>;
}

export interface VerifyBackupPackageOptions {
  path: string;
  passphrase?: string;
  expectedMasterKey?: string | Buffer;
  limits?: Partial<BackupLimits>;
  maxArchiveBytes?: number;
  maxDatabaseBytes?: number;
  maxManifestBytes?: number;
  maxMasterKeyBytes?: number;
  privateWorkDir?: string;
  tempDir?: string;
  appVersion?: string;
  knownMigrations?: string[];
  openDatabase?: SqliteHandleFactory;
  /** Explicit staging is the only mode that returns retained paths. */
  stage?: boolean;
}

export interface VerificationLease {
  directory: string;
  databasePath: string;
  keyPath: string;
  manifestPath: string;
  manifest: BackupManifest;
  masterKey: Buffer;
  report: BackupVerificationReport;
  dispose(): Promise<void>;
}

export interface RestoreBackupPackageOptions extends VerifyBackupPackageOptions {
  targetDir: string;
  /** Original data directory; defaults to SEARCH_HUB_DATA_DIR. */
  sourceDataDir?: string;
  /** Original install directory; defaults to SEARCH_HUB_INSTALL_DIR. */
  sourceInstallDir?: string;
  apply?: boolean;
}

export interface RestoreBackupPackageResult {
  report: BackupVerificationReport;
  applied: boolean;
  targetDir?: string;
  stagingDir?: string;
}

export interface SnapshotMetadata {
  bytes: number;
  sha256: string;
  schemaVersion: string | null;
  userVersion: number;
  migrations: string[];
  snapshotMethod: BackupManifest["database"]["snapshotMethod"];
  journal: "delete";
}
