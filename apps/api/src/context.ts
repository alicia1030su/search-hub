import pino, { type Logger as PinoLogger } from "pino";
import { sql } from "drizzle-orm";
import {
  createSafeFetch,
  type Logger,
  type SafeFetch,
} from "@search-hub/shared";
import { createDb, runMigrations, type DbHandle } from "@search-hub/db";
import { adminUsers } from "@search-hub/db";
import type { AppConfig } from "./config.js";
import { SecretBox, ensureDir } from "./security/crypto.js";
import { clearGeneratedSetupToken, ensureSetupToken, type SetupTokenState } from "./security/setup-token.js";
import { SettingsService } from "./services/settings.js";
import { ProviderService } from "./services/providers.js";
import { ModelService } from "./services/models.js";
import { SearchService } from "./services/search.js";
import { SessionService, TokenService, type AuthDependencies } from "./auth.js";

class FetchProvider {
  private current: SafeFetch | null = null;
  private policyJson = "";

  constructor(private readonly settings: SettingsService) {}

  get(): SafeFetch {
    const policy = this.settings.ssrfPolicy();
    const serialized = JSON.stringify(policy);
    if (!this.current || serialized !== this.policyJson) {
      this.current = createSafeFetch({ policy, timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });
      this.policyJson = serialized;
    }
    return this.current;
  }
}

export interface AppContext {
  config: AppConfig;
  db: DbHandle["db"];
  sqlite: DbHandle["sqlite"];
  closeDb: () => void;
  secrets: SecretBox;
  settings: SettingsService;
  sessions: SessionService;
  tokens: TokenService;
  providers: ProviderService;
  models: ModelService;
  search: SearchService;
  logger: PinoLogger;
  appLogger: Logger;
  fetch: SafeFetch;
  authDeps: AuthDependencies;
  /** First-run token. Null once an administrator exists. */
  setupToken: SetupTokenState;
  refreshSetupToken: () => void;
  migrated: string[];
}

export function createContext(config: AppConfig): AppContext {
  ensureDir(config.dataDir);

  const logger = pino({
    level: config.logLevel,
    base: { service: "search-hub" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.token",
        "*.key",
        "*.csrfToken",
      ],
      censor: "[redacted]",
    },
  });

  const handle = createDb({ file: config.dbPath });
  const migration = runMigrations(handle.sqlite, config.migrationsDir);
  if (migration.applied.length > 0) {
    logger.info({ migrations: migration.applied }, "database migrations applied");
  }

  const adminCount = Number(
    handle.db.select({ count: sql<number>`count(*)` }).from(adminUsers).all()[0]?.count ?? 0,
  );
  let setupToken = ensureSetupToken(config.dataDir, config.setupToken, adminCount > 0);
  if (setupToken.value) {
    logger.warn(
      { source: setupToken.source, file: setupToken.source === "generated" ? setupToken.filePath : undefined },
      setupToken.source === "env"
        ? "First-run setup is protected by SEARCH_HUB_SETUP_TOKEN."
        : "First-run setup token generated. Open /setup and paste this token: " + setupToken.value,
    );
  }

  const refreshSetupToken = () => {
    const count = Number(
      handle.db.select({ count: sql<number>`count(*)` }).from(adminUsers).all()[0]?.count ?? 0,
    );
    if (count > 0) {
      clearGeneratedSetupToken(setupToken);
      setupToken = { ...setupToken, value: null, source: "none" };
    }
  };
  const settings = new SettingsService(handle.db, config);
  const secrets = SecretBox.fromEnvOrFile(config.dataDir, config.encryptionKey);
  const sessions = new SessionService(handle.db, config);
  const tokens = new TokenService(handle.db);
  const providers = new ProviderService(handle.db, secrets);
  const models = new ModelService(handle.db, secrets);
  const fetchProvider = new FetchProvider(settings);
  const fetchProxy: SafeFetch = (url, init) => fetchProvider.get()(url, init);

  models.setFetch(fetchProxy);
  providers.startFlusher();

  const search = new SearchService({
    db: handle.db,
    providers,
    models,
    settings,
    fetch: fetchProxy,
    logger,
  });

  const appLogger = logger as unknown as Logger;

  return {
    config,
    db: handle.db,
    sqlite: handle.sqlite,
    closeDb: handle.close,
    secrets,
    settings,
    sessions,
    tokens,
    providers,
    models,
    search,
    logger,
    appLogger,
    fetch: fetchProxy,
    authDeps: { db: handle.db, sessions, tokens, settings },
    setupToken,
    refreshSetupToken,
    migrated: migration.applied,
  };
}
