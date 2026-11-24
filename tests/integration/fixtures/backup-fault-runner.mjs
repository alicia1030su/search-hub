import { readFileSync } from "node:fs";
import { createBackupPackage, openBuiltInSqlite, restoreBackupPackage } from "../../../packages/backup/src/index.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
try {
  if (config.operation === "create") {
    const result = await createBackupPackage({
      snapshotPath: config.snapshotPath,
      masterKeyValue: Buffer.from(config.masterKeyHex, "hex"),
      outputPath: config.outputPath,
      passphrase: config.passphrase,
      appVersion: config.appVersion,
      migrations: config.migrations,
      keySource: "file",
      creator: "cli",
      dataDir: config.sourceDataDir,
      installDir: config.sourceInstallDir,
      openDatabase: openBuiltInSqlite,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, sha256: result.sha256 })}\n`);
  } else {
    const result = await restoreBackupPackage({
      path: config.packagePath,
      targetDir: config.targetDir,
      sourceDataDir: config.sourceDataDir,
      sourceInstallDir: config.sourceInstallDir,
      passphrase: config.passphrase,
      apply: true,
      openDatabase: openBuiltInSqlite,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, applied: result.applied })}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
