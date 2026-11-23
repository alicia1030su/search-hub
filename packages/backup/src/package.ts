import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline, type Writable } from "node:stream";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Decrypter, Encrypter } from "age-encryption";
import { pack } from "tar-stream";
import { assertDefaultAgeWorkFactor } from "./age-header.js";
import { sha256, sha256File, toWebReadable } from "./hash.js";
import { withBackupLock } from "./lock.js";
import { manifestCompatible, validateManifest } from "./manifest.js";
import { createKeyProof, describeMasterKey, masterKeyFingerprint, parseMasterKey, readMasterKey, safeKeyEqual, verifyKeyProof } from "./master-key.js";
import { EMBEDDED_MIGRATIONS } from "./migrations.js";
import { createOriginGuard } from "./origin.js";
import { validateBackupPassphrase } from "./passphrase.js";
import {
  assertSecureRegularFile, createPrivateDirectory, createPrivateSubdirectory, ensureOutputParent,
  openPrivateFile, publishNoOverwrite, requireDiskBytes,
} from "./private-fs.js";
import { parseStrictJson } from "./strict-json.js";
import { DEFAULT_TAR_LIMITS, readStrictTar, type StrictTarLimits } from "./strict-tar.js";
import {
  BASE_REQUIRED_COLUMNS, emptyReport, inspectSnapshotDatabase, openBuiltInSqlite, schemaColumnsFromMigrations,
  schemaMigrationsCompatible, sealSnapshotDatabase,
} from "./sqlite.js";
import {
  BACKUP_MEMBERS, type BackupLimits, type BackupManifest, type BackupPackageResult,
  type BackupVerificationReport, type CreateBackupPackageOptions, type EmbeddedSchemaContract,
  type VerifyBackupPackageOptions, type VerificationLease,
} from "./types.js";

const pipelineAsync = promisify(pipeline);
const EXTRA_DISK_BYTES = 16 * 1024 * 1024;

export function resolveBackupLimits(limits: Partial<BackupLimits> = {}): StrictTarLimits {
  const result = { ...DEFAULT_TAR_LIMITS, ...limits };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      result.maxMasterKeyBytes > 1024 || result.maxArchiveBytes < result.maxDatabaseBytes) {
    throw new Error("Backup limits are invalid");
  }
  return result;
}
export function resolveVerificationLimits(options: VerifyBackupPackageOptions): StrictTarLimits {
  return resolveBackupLimits({
    ...options.limits,
    ...(options.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: options.maxArchiveBytes }),
    ...(options.maxManifestBytes === undefined ? {} : { maxManifestBytes: options.maxManifestBytes }),
    ...(options.maxDatabaseBytes === undefined ? {} : { maxDatabaseBytes: options.maxDatabaseBytes }),
    ...(options.maxMasterKeyBytes === undefined ? {} : { maxMasterKeyBytes: options.maxMasterKeyBytes }),
  });
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function tarEntrySize(bytes: number): number { return 512 + Math.ceil(bytes / 512) * 512; }
function addTarEntry(archive: ReturnType<typeof pack>, name: string, size: number, body: Buffer | NodeJS.ReadableStream): Promise<void> {
  return new Promise((done, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return; settled = true;
      if (error) reject(error); else done();
    };
    try {
      const sink = archive.entry({ name, size, type: "file", mode: 0o600, uid: 0, gid: 0, mtime: new Date(0) }, finish);
      if (Buffer.isBuffer(body)) sink.end(body);
      else void pipelineAsync(body as NodeJS.ReadableStream, sink as unknown as Writable).catch(finish);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
function embeddedContract(names: readonly string[], supplied?: Readonly<Record<string, string>>): EmbeddedSchemaContract {
  const selected = EMBEDDED_MIGRATIONS.filter((migration) => names.includes(migration.name));
  if (selected.length !== names.length || !sameStrings(selected.map((entry) => entry.name), [...names].sort())) {
    if (!supplied) throw new Error("Unknown migration list; supply migrationSql for every known migration");
  }
  const migrations = (supplied
    ? Object.keys(supplied).sort().map((name) => {
        const sql = supplied[name];
        if (typeof sql !== "string" || sql.length === 0) throw new Error(`Missing embedded SQL for migration ${name}`);
        return { name, sql, sha256: sha256(sql) };
      })
    : EMBEDDED_MIGRATIONS.map((migration) => ({ ...migration })));
  const requiredTables = schemaColumnsFromMigrations(migrations);
  for (const [table, columns] of Object.entries(BASE_REQUIRED_COLUMNS)) {
    if (!requiredTables[table]) throw new Error(`Embedded schema contract is missing required table ${table}`);
    for (const column of columns) if (!requiredTables[table]?.includes(column)) throw new Error(`Embedded schema contract is missing required column ${table}.${column}`);
  }
  return { version: 1, requiredTables, migrations };
}
/** Creates an age(tar) package from a real, strictly inspected SQLite snapshot. */
export async function createBackupPackage(options: CreateBackupPackageOptions): Promise<BackupPackageResult> {
  const passphrase = validateBackupPassphrase(options.passphrase);
  if ((options.snapshotPath === undefined) === (options.snapshotAdapter === undefined)) throw new Error("Provide exactly one of snapshotPath or snapshotAdapter");
  if (options.masterKeyPath === undefined && options.masterKeyValue === undefined) throw new Error("A master key file or value is required");
  const limits = resolveBackupLimits(options.limits);
  const outputPath = resolve(options.outputPath);
  if (!outputPath.toLowerCase().endsWith(".shbackup")) throw new Error("Backup output must use the .shbackup extension");
  if (existsSync(outputPath)) throw new Error("Backup output already exists; refusing to overwrite it");
  const key = options.masterKeyValue === undefined ? await readMasterKey(options.masterKeyPath as string) : parseMasterKey(options.masterKeyValue);
  const openDatabase = options.openDatabase ?? options.snapshotAdapter?.openDatabase ?? openBuiltInSqlite;
  const work = await createPrivateDirectory(tmpdir(), "shbackup-create-");
  const temporaryPath = join(dirname(outputPath), `.${randomBytes(12).toString("hex")}.shbackup.tmp`);
  let published = false;
  try {
    let snapshotPath = options.snapshotPath;
    let snapshotMethod: BackupManifest["database"]["snapshotMethod"] = options.snapshotMethod ?? "provided";
    if (options.snapshotAdapter) {
      snapshotPath = join(work, "snapshot.db");
      const snapshot = await options.snapshotAdapter.createSnapshot(snapshotPath);
      if (!snapshot.walCheckpointed) throw new Error("Snapshot adapter did not produce a checkpointed snapshot");
      snapshotMethod = snapshot.method;
    }
    if (!snapshotPath) throw new Error("Snapshot path is unavailable");
    if (options.snapshotAdapter) sealSnapshotDatabase(snapshotPath, openDatabase);
    const snapshotInfo = await assertSecureRegularFile(snapshotPath, limits.maxDatabaseBytes);
    await requireDiskBytes(work, snapshotInfo.size + EXTRA_DISK_BYTES);
    await requireDiskBytes(dirname(outputPath), snapshotInfo.size * 2 + EXTRA_DISK_BYTES);
    const inspection = inspectSnapshotDatabase(snapshotPath, openDatabase, key);
    if (!inspection.headerOk || !inspection.integrityOk || !inspection.foreignKeysOk || !inspection.requiredSchemaOk ||
        inspection.journalMode !== "delete" || !inspection.userVersionOk || !sameStrings(inspection.migrations, options.migrations)) {
      throw new Error(`Refusing to package an invalid or inconsistent SQLite snapshot: ${inspection.integrityDetail}`);
    }
    if (inspection.sampleCount > 0 && inspection.ciphertextSampleDecryptable !== true) throw new Error("Snapshot business ciphertext samples do not decrypt with the supplied master key");
    const dbSha256 = await sha256File(snapshotPath);
    const packageId = randomUUID();
    const fingerprint = masterKeyFingerprint(key);
    const manifest: BackupManifest = {
      format: "shbackup-v1", packageId, createdAt: new Date().toISOString(),
      producer: { appVersion: options.appVersion, commit: options.commit ?? "unknown" },
      database: {
        path: "data/search-hub.db", bytes: snapshotInfo.size, sha256: dbSha256,
        schemaVersion: inspection.migrations.at(-1) ?? null, userVersion: inspection.userVersion,
        migrations: [...inspection.migrations], snapshotMethod, journal: "delete",
      },
      key: describeMasterKey(key, options.keySource), members: [...BACKUP_MEMBERS], limits,
      encryption: { format: "age-v1", kdf: "scrypt", aead: "ChaCha20-Poly1305", workFactor: 18 },
      originGuard: options.originGuard ?? createOriginGuard(options.dataDir ?? dirname(snapshotPath), options.installDir ?? process.cwd()),
      schemaContractVersion: 1,
      schemaContract: embeddedContract(options.migrations, options.migrationSql),
      keyProof: createKeyProof(key, packageId, fingerprint),
    };
    validateManifest(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.length > limits.maxManifestBytes) throw new Error("Manifest exceeds its configured byte limit");
    const keyBytes = Buffer.from(`${key.toString("hex")}\n`, "utf8");
    const archiveBytes = tarEntrySize(manifestBytes.length) + tarEntrySize(snapshotInfo.size) + tarEntrySize(keyBytes.length) + 1024;
    if (archiveBytes > limits.maxArchiveBytes) throw new Error("Database is too large for the configured package limit");
    await ensureOutputParent(outputPath);
    await withBackupLock(outputPath, async () => {
      const archive = pack();
      const encrypter = new Encrypter();
      encrypter.setPassphrase(passphrase); // Never expose or invoke a work-factor downgrade.
      const encrypted = await encrypter.encrypt(toWebReadable(Readable.from(archive as unknown as AsyncIterable<Uint8Array>)));
      const handle = await openPrivateFile(temporaryPath);
      const outputDone = pipelineAsync(Readable.fromWeb(encrypted), createWriteStream("", { fd: handle.fd, autoClose: false }));
      void outputDone.catch(() => undefined);
      try {
        await addTarEntry(archive, "manifest.json", manifestBytes.length, manifestBytes);
        await addTarEntry(archive, "data/search-hub.db", snapshotInfo.size, createReadStream(snapshotPath));
        await addTarEntry(archive, "keys/master.key", keyBytes.length, keyBytes);
        archive.finalize();
        await outputDone;
      } finally { await handle.close().catch(() => undefined); }
      const actualHeader = await assertDefaultAgeWorkFactor(temporaryPath);
      if (actualHeader.workFactor !== manifest.encryption.workFactor) throw new Error("Created age header work factor does not match the manifest");
      await publishNoOverwrite(temporaryPath, outputPath);
      published = true;
    });
    const report = emptyReport(0);
    report.format = "shbackup-v1"; report.formatOk = true; report.structuralOk = true; report.schemaCompatible = true;
    report.keyFingerprintMatch = true; report.ciphertextSampleDecryptable = true; report.restoreReadiness = true;
    report.keyReadiness = "verified"; report.sampleCount = inspection.sampleCount; report.keyProofValid = true; report.sha256Match = true;
    report.bytes = (await assertSecureRegularFile(outputPath, limits.maxArchiveBytes)).size; report.dbBytes = snapshotInfo.size; report.dbSha256 = dbSha256;
    report.schemaVersion = inspection.migrations.at(-1) ?? null; report.userVersion = inspection.userVersion; report.migrations = [...inspection.migrations];
    report.headerOk = true; report.integrity = "ok"; report.foreignKeys = "ok"; report.requiredSchema = "ok"; report.journalMode = "delete";
    return { path: outputPath, bytes: report.bytes, sha256: await sha256File(outputPath), manifest, members: [...BACKUP_MEMBERS], report };
  } catch (error) {
    if (published) await rmOwnedOutput(outputPath);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function rmOwnedOutput(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export function packageVersionCompatible(manifest: BackupManifest, appVersion: string): boolean { return manifestCompatible(manifest, appVersion); }

export async function verifyBackupPackage(options: VerifyBackupPackageOptions & { stage: true }): Promise<VerificationLease>;
export async function verifyBackupPackage(options: VerifyBackupPackageOptions): Promise<BackupVerificationReport>;
export async function verifyBackupPackage(options: VerifyBackupPackageOptions): Promise<BackupVerificationReport | VerificationLease> {
  const passphrase = options.passphrase === undefined ? null : validateBackupPassphrase(options.passphrase);
  if (passphrase === null) throw new Error("A backup passphrase is required for .shbackup verification");
  const limits = resolveVerificationLimits(options);
  return withBackupLock(options.path, async () => {
    const info = await assertSecureRegularFile(options.path, limits.maxArchiveBytes);
    await assertDefaultAgeWorkFactor(options.path);
    const privateRoot = options.privateWorkDir ?? options.tempDir ?? tmpdir();
    await requireDiskBytes(privateRoot, info.size + EXTRA_DISK_BYTES);
    const directory = await createPrivateDirectory(privateRoot, "shbackup-verify-");
    let completed = false;
    try {
      await createPrivateSubdirectory(directory, "data");
      await createPrivateSubdirectory(directory, "keys");
      const paths = new Map<string, string>();
      const sizes = new Map<string, number>();
      const decrypter = new Decrypter(); decrypter.addPassphrase(passphrase);
      const decrypted = await decrypter.decrypt(toWebReadable(createReadStream(options.path)));
      for await (const entry of readStrictTar(decrypted, limits)) {
        const destination = join(directory, entry.name);
        const handle = await openPrivateFile(destination);
        let written = 0;
        try {
          for await (const chunk of entry.body) {
            written += chunk.byteLength;
            if (written > entry.size) throw new Error("Archive member exceeded its declared size");
            await handle.write(chunk);
          }
          await handle.sync();
        } finally { await handle.close(); }
        if (written !== entry.size) throw new Error(`Archive member size mismatch: ${entry.name}`);
        paths.set(entry.name, destination); sizes.set(entry.name, written);
      }
      const manifestPath = paths.get("manifest.json"); const databasePath = paths.get("data/search-hub.db"); const keyPath = paths.get("keys/master.key");
      if (!manifestPath || !databasePath || !keyPath || paths.size !== BACKUP_MEMBERS.length) throw new Error("Backup extraction did not produce all required members");
      const { readFile } = await import("node:fs/promises");
      const manifest = validateManifest(parseStrictJson(await readFile(manifestPath, "utf8")));
      if (!sameStrings(manifest.members, BACKUP_MEMBERS) ||
          manifest.limits.maxArchiveBytes !== limits.maxArchiveBytes || manifest.limits.maxManifestBytes !== limits.maxManifestBytes ||
          manifest.limits.maxDatabaseBytes !== limits.maxDatabaseBytes || manifest.limits.maxMasterKeyBytes !== limits.maxMasterKeyBytes) {
        throw new Error("Manifest members or limits do not match the verification policy");
      }
      const key = parseMasterKey(await readFile(keyPath, "utf8"));
      const expected = options.expectedMasterKey === undefined ? null : parseMasterKey(options.expectedMasterKey);
      const dbSha256 = await sha256File(databasePath);
      const dbInfo = await assertSecureRegularFile(databasePath, limits.maxDatabaseBytes);
      const manifestHashOk = dbSha256 === manifest.database.sha256 && dbInfo.size === manifest.database.bytes && sizes.get("data/search-hub.db") === manifest.database.bytes;
      const inspection = inspectSnapshotDatabase(databasePath, options.openDatabase ?? openBuiltInSqlite, expected ?? key, BASE_REQUIRED_COLUMNS);
      const report = emptyReport(info.size);
      report.format = "shbackup-v1"; report.formatOk = true; report.sha256Match = manifestHashOk;
      report.headerOk = inspection.headerOk; report.integrity = inspection.integrityOk ? "ok" : "failed";
      report.foreignKeys = inspection.foreignKeysOk ? "ok" : "failed"; report.requiredSchema = inspection.requiredSchemaOk ? "ok" : "failed";
      report.journalMode = inspection.journalMode; report.userVersion = inspection.userVersion; report.migrations = inspection.migrations;
      report.schemaVersion = inspection.migrations.at(-1) ?? null; report.dbBytes = dbInfo.size; report.dbSha256 = dbSha256; report.sampleCount = inspection.sampleCount;
      const manifestDbMatches = manifest.database.bytes === dbInfo.size && manifest.database.sha256 === dbSha256 &&
        manifest.database.userVersion === inspection.userVersion && sameStrings(manifest.database.migrations, inspection.migrations);
      report.structuralOk = manifestHashOk && manifestDbMatches && inspection.headerOk && inspection.integrityOk && inspection.foreignKeysOk &&
        inspection.requiredSchemaOk && inspection.journalMode === "delete" && inspection.userVersionOk;
      const known = options.knownMigrations ?? EMBEDDED_MIGRATIONS.map((entry) => entry.name);
      report.schemaCompatible = report.structuralOk && schemaMigrationsCompatible(inspection.migrations, known, inspection.userVersion) &&
        (options.appVersion === undefined || manifestCompatible(manifest, options.appVersion));
      const bundledFingerprintOk = masterKeyFingerprint(key) === manifest.key.fingerprint;
      const expectedFingerprintOk = expected === null || masterKeyFingerprint(expected) === manifest.key.fingerprint;
      report.keyFingerprintMatch = bundledFingerprintOk && expectedFingerprintOk && (expected === null || safeKeyEqual(expected, key));
      const bundledProof = verifyKeyProof(key, manifest.keyProof, manifest.packageId, manifest.key.fingerprint);
      const expectedProof = expected === null || verifyKeyProof(expected, manifest.keyProof, manifest.packageId, manifest.key.fingerprint);
      report.keyProofValid = bundledProof && expectedProof;
      report.ciphertextSampleDecryptable = inspection.sampleCount === 0 ? report.keyProofValid : inspection.ciphertextSampleDecryptable === true && report.keyProofValid;
      report.keyReadiness = !report.keyFingerprintMatch || !report.keyProofValid ? "mismatch" : report.ciphertextSampleDecryptable ? "verified" : "unverified";
      report.restoreReadiness = report.formatOk && report.structuralOk && report.schemaCompatible && report.keyFingerprintMatch &&
        report.ciphertextSampleDecryptable && report.keyReadiness === "verified";
      if (!report.structuralOk) report.reason = inspection.integrityDetail === "ok" ? "database or manifest structural checks failed" : inspection.integrityDetail;
      else if (!report.schemaCompatible) report.reason = "backup schema is incompatible with this build";
      else if (!report.keyFingerprintMatch) report.reason = "master key fingerprint mismatch";
      if (options.stage === true) {
        completed = true;
        let disposed = false;
        return {
          directory, databasePath, keyPath, manifestPath, manifest, masterKey: key, report,
          dispose: async () => { if (!disposed) { disposed = true; await rm(directory, { recursive: true, force: true }); } },
        };
      }
      return report;
    } finally { if (!completed) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  });
}

/** Default verification is ephemeral; callers must not depend on returned paths. */
export async function disposeVerification(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
