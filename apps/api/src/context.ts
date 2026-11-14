import pino, { type Logger as PinoLogger } from "pino";
import { sql } from "drizzle-orm";
import {
  createSafeFetch,
  describeOutboundPolicy,
  resolveOutboundProxy,
  type Logger,
  type OutboundPolicyDescription,
  type ResolvedOutboundProxy,
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

  constructor(
    private readonly settings: SettingsService,
    private readonly outbound: ResolvedOutboundProxy,
  ) {}

  get(): SafeFetch {
    const policy = this.settings.ssrfPolicy();
    // The proxy configuration is fixed for the process lifetime; only the SSRF
    // policy is mutable, so the cache key is the policy plus the proxy identity.
    const serialized = `${JSON.stringify(policy)}|${this.outbound.trust}|${this.outbound.proxy?.display ?? "direct"}`;
    if (!this.current || serialized !== this.policyJson) {
      this.current = createSafeFetch({
        policy,
        proxy: this.outbound,
        timeoutMs: 30_000,
        maxBytes: 4 * 1024 * 1024,
      });
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
  /** Resolved proxy configuration; fixed for the process lifetime. */
  outboundProxy: ResolvedOutboundProxy;
  /** Credential-free description of the current outbound policy. */
  describeOutboundPolicy: () => OutboundPolicyDescription;
  authDeps: AuthDependencies;
  /** First-run token. Null once an administrator exists. */
  setupToken: SetupTokenState;
  refreshSetupToken: () => void;
  migrated: string[];
}

export function createContext(config: AppConfig): AppContext {
  ensureDir(config.dataDir);

  // Resolve the outbound proxy before any network call. An invalid proxy URL,
  // unsupported scheme or unknown trust level throws here, so a bad deployment
  // value fails closed at boot rather than silently falling back to a direct
  // connection.
  const outboundProxy = resolveOutboundProxy(config.outboundProxy ?? {});

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
        : "First-run setup token generated at " + setupToken.filePath +
          " (mode 0600). Read it from the file; the value is never written to the log.",
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
  const fetchProvider = new FetchProvider(settings, outboundProxy);
  const fetchProxy: SafeFetch = (url, init) => fetchProvider.get()(url, init);

  models.setFetch(fetchProxy);
  providers.startFlusher();

  const describeOutbound = () => describeOutboundPolicy(settings.ssrfPolicy(), outboundProxy);

  // Print the egress mode once at boot. Credentials never appear here: the
  // description only carries the redacted proxy endpoint.
  const outboundDescription = describeOutbound();
  if (outboundDescription.mode === "proxy") {
    logger.info(
      {
        outbound: {
          mode: outboundDescription.mode,
          proxy: outboundDescription.proxyHost,
          trust: outboundDescription.proxyTrust,
          trustDeclared: outboundDescription.proxyTrustDeclared,
          noProxyEntries: outboundDescription.noProxyEntries,
          privateHostAllowlistHonored: outboundDescription.privateHostAllowlistHonored,
        },
      },
      `Outbound traffic uses HTTP proxy ${outboundDescription.proxyHost} (trust=${outboundDescription.proxyTrust}).`,
    );
    for (const warning of outboundDescription.warnings) logger.warn({ outbound: true }, warning);
  } else {
    logger.info({ outbound: { mode: "direct" } }, "Outbound traffic uses direct connections.");
  }

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
    outboundProxy,
    describeOutboundPolicy: describeOutbound,
    authDeps: { db: handle.db, sessions, tokens, settings },
    setupToken,
    refreshSetupToken,
    migrated: migration.applied,
  };
}
