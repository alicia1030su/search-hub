import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const app = await buildApp(ctx);

  const runRetention = () => {
    try {
      const result = ctx.search.runRetention();
      if (result.tasks + result.events + result.auditLogs > 0) {
        ctx.logger.info(result, "retention cleanup removed old records");
      }
    } catch (error) {
      ctx.logger.warn({ err: error }, "retention cleanup failed");
    }
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, 3_600_000);
  retentionTimer.unref();

  const close = async (signal: string) => {
    clearInterval(retentionTimer);
    ctx.logger.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: config.host });
    ctx.logger.info(
      {
        port: config.port,
        host: config.host,
        db: ctx.config.dbPath,
        encryptionKeySource: ctx.secrets.source,
        staticDir: ctx.config.staticDir,
      },
      "Search Hub listening",
    );
    // Background probes. The timer only *ticks*; whether anything is probed is
    // decided by settings (scheduledEnabled / intervalMinutes / budgets), so this
    // never starts spending on its own.
    const stopHealth = ctx.health.startScheduler();
    process.on("exit", () => stopHealth());

    if (ctx.secrets.source === "file") {
      ctx.logger.warn(
        "Encryption key loaded from data/master.key. Back it up together with the database, " +
          "or stored API keys cannot be decrypted after a restore.",
      );
    }
  } catch (error) {
    ctx.logger.error({ err: error }, "failed to start");
    process.exitCode = 1;
    await app.close();
  }
}

// Boot failures (invalid proxy configuration, a database written by a newer
// release, an unwritable data directory) must be a one-line, actionable message
// instead of an unhandled stack trace. Details stay in the error's code; no
// secret is printed (proxy URLs are redacted by the config layer).
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "error";
  console.error(`[search-hub] failed to start (${code}): ${message}`);
  process.exit(1);
});
