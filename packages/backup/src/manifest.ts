import { createHash } from "node:crypto";
import {
  BACKUP_FORMAT,
  BACKUP_MEMBERS,
  type BackupLimits,
  type BackupManifest,
  type EmbeddedSchemaContract,
  type OriginGuard,
} from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Manifest ${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Manifest ${label} has missing or unknown fields`);
  }
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Manifest ${label} must be a non-empty string`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Manifest ${label} must be a non-negative safe integer`);
  return value;
}
function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Manifest ${label} must be lowercase SHA-256`);
  return result;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Manifest ${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}
function canonicalBase64(value: unknown, label: string, bytes: number): string {
  const encoded = string(value, label);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(`Manifest ${label} is not base64`);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== encoded) throw new Error(`Manifest ${label} is not canonical base64`);
  return encoded;
}

export function parseSemver(version: string): [number, number, number, string[]] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), (match[4] ?? "").split(".").filter(Boolean)];
}
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left); const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  if (a[3].length === 0 && b[3].length === 0) return 0;
  if (a[3].length === 0) return 1;
  if (b[3].length === 0) return -1;
  for (let index = 0; index < Math.max(a[3].length, b[3].length); index += 1) {
    const av = a[3][index]; const bv = b[3][index];
    if (av === undefined) return -1; if (bv === undefined) return 1; if (av === bv) continue;
    const an = /^\d+$/.test(av); const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) - Number(bv); if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function validateLimits(value: unknown): BackupLimits {
  const root = object(value, "limits");
  exactKeys(root, ["maxArchiveBytes", "maxManifestBytes", "maxDatabaseBytes", "maxMasterKeyBytes"], "limits");
  const result = {
    maxArchiveBytes: integer(root["maxArchiveBytes"], "limits.maxArchiveBytes"),
    maxManifestBytes: integer(root["maxManifestBytes"], "limits.maxManifestBytes"),
    maxDatabaseBytes: integer(root["maxDatabaseBytes"], "limits.maxDatabaseBytes"),
    maxMasterKeyBytes: integer(root["maxMasterKeyBytes"], "limits.maxMasterKeyBytes"),
  };
  if (result.maxArchiveBytes < 2048 || result.maxManifestBytes < 1024 || result.maxDatabaseBytes < 512 ||
      result.maxMasterKeyBytes < 65 || result.maxMasterKeyBytes > 1024 || result.maxArchiveBytes < result.maxDatabaseBytes) {
    throw new Error("Manifest limits are inconsistent");
  }
  return result;
}

function validateOrigin(value: unknown): OriginGuard {
  const root = object(value, "originGuard");
  exactKeys(root, ["algorithm", "dataDir", "installDir"], "originGuard");
  if (root["algorithm"] !== "sha256-prefix-v1") throw new Error("Manifest originGuard algorithm is unsupported");
  return { algorithm: "sha256-prefix-v1", dataDir: digest(root["dataDir"], "originGuard.dataDir"), installDir: digest(root["installDir"], "originGuard.installDir") };
}

function validateContract(value: unknown): EmbeddedSchemaContract {
  const root = object(value, "schemaContract");
  exactKeys(root, ["version", "requiredTables", "migrations"], "schemaContract");
  if (root["version"] !== 1) throw new Error("Manifest schemaContract version is unsupported");
  const tables = object(root["requiredTables"], "schemaContract.requiredTables");
  const requiredTables: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [table, columns] of Object.entries(tables)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Manifest schema contract has an invalid table name");
    requiredTables[table] = stringArray(columns, `schemaContract.requiredTables.${table}`);
  }
  if (!Array.isArray(root["migrations"])) throw new Error("Manifest schemaContract.migrations must be an array");
  const migrations = root["migrations"].map((entry) => {
    const item = object(entry, "schemaContract migration");
    exactKeys(item, ["name", "sql", "sha256"], "schemaContract migration");
    return { name: string(item["name"], "migration.name"), sql: string(item["sql"], "migration.sql"), sha256: digest(item["sha256"], "migration.sha256") };
  });
  const names = migrations.map((migration) => migration.name);
  if (new Set(names).size !== names.length) throw new Error("Manifest schema contract has duplicate migrations");
  if (migrations.some((migration) => createHash("sha256").update(migration.sql).digest("hex") !== migration.sha256)) throw new Error("Manifest embedded migration checksum mismatch");
  return { version: 1, requiredTables, migrations };
}

/** Parses and validates every locked field used by verification and restore. */
export function validateManifest(value: unknown): BackupManifest {
  const root = object(value, "root");
  exactKeys(root, ["format", "packageId", "createdAt", "producer", "database", "key", "members", "limits", "encryption", "originGuard", "schemaContractVersion", "schemaContract", "keyProof"], "root");
  if (root["format"] !== BACKUP_FORMAT) throw new Error("Unsupported backup format");
  const createdAt = string(root["createdAt"], "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Manifest createdAt is not a valid timestamp");
  const packageId = string(root["packageId"], "packageId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(packageId)) throw new Error("Manifest packageId must be a UUID v4");
  const producer = object(root["producer"], "producer");
  exactKeys(producer, ["appVersion", "commit"], "producer");
  parseSemver(string(producer["appVersion"], "producer.appVersion"));
  const commit = string(producer["commit"], "producer.commit");
  const database = object(root["database"], "database");
  exactKeys(database, ["path", "bytes", "sha256", "schemaVersion", "userVersion", "migrations", "snapshotMethod", "journal"], "database");
  if (database["path"] !== "data/search-hub.db") throw new Error("Manifest database.path is invalid");
  if (database["snapshotMethod"] !== "sqlite_backup_api" && database["snapshotMethod"] !== "vacuum_into" && database["snapshotMethod"] !== "provided") throw new Error("Manifest database.snapshotMethod is invalid");
  if (database["journal"] !== "delete") throw new Error("Manifest database.journal must be delete");
  const key = object(root["key"], "key");
  exactKeys(key, ["source", "fingerprint"], "key");
  if (key["source"] !== "env" && key["source"] !== "file") throw new Error("Manifest key.source is invalid");
  if (!Array.isArray(root["members"]) || root["members"].length !== BACKUP_MEMBERS.length || root["members"].some((member, index) => member !== BACKUP_MEMBERS[index])) throw new Error("Manifest members must match the fixed ordered allowlist");
  const encryption = object(root["encryption"], "encryption");
  exactKeys(encryption, ["format", "kdf", "aead", "workFactor"], "encryption");
  if (encryption["format"] !== "age-v1" || encryption["kdf"] !== "scrypt" || encryption["aead"] !== "ChaCha20-Poly1305" || encryption["workFactor"] !== 18) throw new Error("Manifest encryption policy is unsupported");
  if (root["schemaContractVersion"] !== 1) throw new Error("Manifest schemaContractVersion is unsupported");
  const proof = object(root["keyProof"], "keyProof");
  exactKeys(proof, ["version", "algorithm", "iv", "tag", "ciphertext"], "keyProof");
  if (proof["version"] !== 1 || proof["algorithm"] !== "aes-256-gcm") throw new Error("Manifest keyProof policy is unsupported");
  canonicalBase64(proof["iv"], "keyProof.iv", 12);
  canonicalBase64(proof["tag"], "keyProof.tag", 16);
  const proofCiphertext = canonicalBase64(proof["ciphertext"], "keyProof.ciphertext", Buffer.byteLength("search-hub-master-key-proof-v1") + 1 + 32);
  const migrations = stringArray(database["migrations"], "database.migrations");
  if (new Set(migrations).size !== migrations.length) throw new Error("Manifest database migrations contain duplicates");
  if (integer(database["userVersion"], "database.userVersion") !== migrations.length) throw new Error("Manifest database.userVersion does not match migrations");
  const schemaContract = validateContract(root["schemaContract"]);
  if (migrations.some((migration) => !schemaContract.migrations.some((entry) => entry.name === migration))) throw new Error("Manifest is missing embedded migration SQL");
  return {
    format: BACKUP_FORMAT,
    packageId,
    createdAt,
    producer: { appVersion: producer["appVersion"] as string, commit },
    database: {
      path: "data/search-hub.db",
      bytes: integer(database["bytes"], "database.bytes"),
      sha256: digest(database["sha256"], "database.sha256"),
      schemaVersion: typeof database["schemaVersion"] === "string" ? database["schemaVersion"] : null,
      userVersion: migrations.length,
      migrations,
      snapshotMethod: database["snapshotMethod"] as BackupManifest["database"]["snapshotMethod"],
      journal: "delete",
    },
    key: { source: key["source"] as "env" | "file", fingerprint: digest(key["fingerprint"], "key.fingerprint") },
    members: [...BACKUP_MEMBERS],
    limits: validateLimits(root["limits"]),
    encryption: { format: "age-v1", kdf: "scrypt", aead: "ChaCha20-Poly1305", workFactor: 18 },
    originGuard: validateOrigin(root["originGuard"]),
    schemaContractVersion: 1,
    schemaContract,
    keyProof: { version: 1, algorithm: "aes-256-gcm", iv: proof["iv"] as string, tag: proof["tag"] as string, ciphertext: proofCiphertext },
  };
}

export function manifestCompatible(manifest: BackupManifest, appVersion: string): boolean {
  return compareSemver(manifest.producer.appVersion, appVersion) <= 0;
}

export function requireAllMembers(seen: ReadonlySet<string>): void {
  if (seen.size !== BACKUP_MEMBERS.length || BACKUP_MEMBERS.some((member) => !seen.has(member))) {
    throw new Error("Backup package must contain exactly the three fixed members");
  }
}
