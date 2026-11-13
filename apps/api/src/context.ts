import pino, { type Logger as PinoLogger } from "pino";
import {
  createSafeFetch,
  type Logger,
  type SafeFetch,
} from "@search-hub/shared";
import { createDb, runMigrations, type DbHandle } from "@search-hub/db";
import type { AppConfig } from "./config.js";
import { SecretBox, ensureDir } from "./security/crypto.js";
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
  const migration = runMigrations(handle.sqlite);
  if (migration.applied.length > 0) {
    logger.info({ migrations: migration.applied }, "database migrations applied");
  }

  const secrets = SecretBox.fromEnvOrFile(config.dataDir, config.encryptionKey);
  const settings = new SettingsService(handle.db, config);
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
    migrated: migration.applied,
  };
}
