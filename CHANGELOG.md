# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.1.7-beta.2 (2026-11-18)

Quality pass on the health centre, a complete English locale, and real
network-failure coverage. No new providers, no architecture change.

### Added

- **Complete en-US locale** with a header switcher, persisted in `localStorage`.
  Chinese stays the default. The English dictionary is typed
  `Record<MessageKey, string>`, so a missing key fails the typecheck instead of
  rendering Chinese inside an English page; dates and numbers resolve their
  `Intl` formatter per locale.
- **Real DNS/TLS/connection failure tests** through the actual fetch path: an
  `.invalid` hostname, a self-signed certificate, TLS against a plaintext port,
  a closed port, a server that never answers, an HTML body where JSON is
  expected, an abort mid-flight, and a redirect into a private address.
- **systemd + health scheduler acceptance** in the real unit: a scheduled probe
  under `systemctl`, restart preserving `nextProbeAt` and the budget counter, a
  stopped unit not probing, and an upgrade + rollback that does not reset the
  daily counter.
- **Build provenance** for release assets (`actions/attest-build-provenance`),
  verified after upload with `gh attestation verify`. SHA256 verification and
  provenance are reported separately: one proves the bytes, the other proves who
  built them.

### Fixed

- **Keyless sources were reported as broken.** `/api/health` counted "has a
  healthy key" as healthy, so Hacker News, Crossref, OpenAlex, PubMed, arXiv and
  Wikipedia — none of which take a key — showed as unusable on an instance where
  they work. It now counts enabled-and-usable.
- **A real search probe was refused for keyless sources** with "paid probes are
  disabled". A keyless request sends no credential and cannot spend account
  quota, so blocking it made public sources permanently unverifiable. They now
  run without the paid switch and are counted in their own
  `anonymousSearchUsedToday` bucket — counted, not called free, because whether
  a vendor meters by IP is not knowable here.
- **A probe used the raw search settings instead of the resolved plan**, so
  every paginated adapter computed `Math.max(1, undefined)` pages, issued no
  request, and returned an empty list: a working vendor was recorded as
  `empty_results`.
- **Certificate failures were classified as `network`.** safe-fetch wraps socket
  errors, so the OpenSSL verdict sits in the cause chain; the classifier now
  looks one level down for a TLS or DNS marker, which changes the cooldown from
  20 seconds to 30 minutes.
- **A cancelled probe refunded its budget slot.** A cancel can arrive after the
  request left the machine, so refunding it let an abort loop spend unbounded
  paid requests while the ledger reported zero. Only a probe that provably never
  left is refunded.

## v0.1.7-beta.1 (2026-11-17)

### Provider health management centre

- **Two axes, deliberately separate.** Implementation verification
  (`documented` / `mock_verified` / `live_tested` / `unverified` /
  `no_official_api`) comes from the catalog and is never written by a probe. A
  green connectivity check therefore cannot upgrade a `documented` adapter to a
  "live integration", and a provider with no API key never reports healthy.
- **Runtime state** is derived from the stored status, the classified cause, the
  credential pool and the cooldown: `unknown` / `healthy` / `degraded` /
  `unhealthy` / `rate_limited` / `quota_exceeded` / `invalid_credentials` /
  `permission_denied` / `cooldown` / `unverified` / `disabled`. Only
  `quota_exceeded` and `invalid_credentials` gate a search; one timeout never
  removes a source.
- **Two probe kinds.** `connect` is free and only proves DNS/TLS/auth/reachability;
  `search` calls the vendor's paid endpoint and is the only thing that can claim
  "it can search right now". Fixed, non-private probe queries; paid probing is
  off by default.
- **Durable budget.** New table `health_probe_budget` (one row per UTC day per
  kind) reserved by a conditional `UPDATE ... WHERE used < max`, so concurrent
  probes cannot overspend. 3 per run / 20 per day by default, hard caps at 200 /
  2000. Seeded from existing probe rows on upgrade so a mid-day upgrade does not
  hand out a second day of budget. A reservation that cannot be written means no
  request is made. Paid probes are 429 when the ledger is full; connectivity
  probes are counted separately and not capped.
- **Per-provider scheduling.** New table `provider_probe_state` holds the per
  provider switch, consecutive failures, backoff level, `nextProbeAt` and the
  reset marker. Transient failures retry sooner (bounded exponential +
  jitter); terminal failures wait for the normal interval; success resets
  everything. In-flight de-duplication keeps two passes from probing one source
  at once.
- **Lifecycle.** The scheduler is re-entrancy guarded, unrefs its timer, stops on
  shutdown before the database closes, and never keeps the process alive.
- **Admin surface**: `GET/PUT /api/admin/provider-health/settings`,
  `GET /api/admin/provider-health`, `GET .../history`,
  `POST .../:id/probe`, `POST .../:id/auto-probe`, `POST .../:id/reset`
  (reset records a marker so old rows stop deciding the status; it never deletes
  history and never re-enables a rejected key). Admin scope + CSRF; a
  `search`-scope token gets 403.
- **Panel**: runtime state and implementation verification shown side by side,
  both probe modes (the paid one is labelled), next probe time, history dialog,
  per-provider auto-probe switch, reset with confirmation, and the policy card
  with schedule, interval, both budget ceilings and concurrency.

### Fixed

- The scheduled pass applied a single global interval gate, which also blocked
  the fast retries that backoff exists for. Scheduling is now per provider.
- A cancelled probe was recorded as a provider failure. Cancellation now
  records nothing and returns the reserved budget.



### Persistent search cache

- **The cache survives restarts.** Search responses are now rows in SQLite
  (migration `0004_search_cache.sql`) instead of a `Map`. A service restart, a
  host reboot or a Docker `down`/`up` with the data volume kept no longer throws
  away a full TTL of cached results, and the existing backup/upgrade paths cover
  it without changes. A cache hit still creates a new `searchTasks` row with a new
  `taskId`, and `stats.cached` is reported on REST and MCP alike.
- **TTL is 1–72 hours**, default 24. The UI talks in hours while the stored unit
  stays `ttlSeconds`, so existing clients and settings documents keep working.
  Validation runs on the *merged* settings, so `{enabled:true}` cannot slip past,
  and negative / fractional / >72h values are refused rather than clamped.
  Changing the TTL re-times existing entries: shortening takes effect immediately
  and lengthening never revives something that already expired.
- **Bounded**: 5000 entries / 256 MB, evicting the least recently used row inside
  the same transaction as the write. `size_bytes` is the UTF-8 byte length of the
  stored JSON, not the JavaScript string length.
- **Background sweep** at startup and every 10 minutes: only `expires_at <= now`,
  re-entrancy guarded, errors logged rather than fatal, timer cleared on shutdown.
  No VACUUM — a shrunken file is not worth blocking the writer on every sweep.
- **Only fully successful responses are cached.** Failures, cancellations, partial
  results and anything carrying an error entry are re-queried. A completed search
  with zero results *is* cached. `includeRaw=true` bypasses the persistent cache
  entirely, because raw payloads are provider-internal data.
- **The cache key is a SHA-256 of the request fingerprint** — query, mode,
  capability, provider configuration plus a credential version, limit /
  perProviderLimit / timeoutMs / language / freshness, the rerank / embedding /
  summary switches, the resolved model fingerprints, and the current health-gate
  verdict. No query text and no credential ever lands in the table.
- **A cache hit does not bypass the health gate**: a source parked right now is
  still reported as skipped instead of looking healthy because it worked before.
- **Admin surface**: `GET /api/admin/cache` (entries, bytes, cumulative and 24-hour
  hit rate, evictions, last sweep), `POST /api/admin/cache/sweep`,
  `POST /api/admin/cache/clear` (requires `{"confirm":true}` and writes an audit
  log). Statistics come from hourly buckets, so a restart does not zero the rate
  and an empty window reports `null` rather than a fabricated 0%.

### Changed

- A cached `partial` response is no longer stored at all (it used to be cached and
  replayed as `partial`). Replaying "one of your sources is broken" for 24 hours
  would hide a source that recovered a minute later.
- `packages/mcp` `search_web` now returns `cached`, matching REST.

## v0.1.6-beta.1 (2026-11-16)

Health monitoring exposed over every surface, health-gated search, and a safe
program updater. Supersedes `v0.1.5-beta.1`, which shipped without the MiniMax /
Metaso / Metaso-MCP catalogue entries.

### Provider health

- **MCP**: `get_provider_health` (tool count 10 → 11). Read-only by construction —
  it reads the last recorded probes and has no path to `checkOne`, so a
  search-scope token cannot spend vendor quota through it.
- **`/api/mcp/health`**: a projection for the stdio bridge with the same derived
  fields and none of the sensitive ones (no base URL, no history, no key
  material). `/api/admin/health` still requires the admin scope; a search token
  gets 403, covered by a test.
- **Dashboard**: live per-source status, last check, P50, success rate and error
  code — the same `HealthOverview` the 健康监控 tab and the MCP tool read.
- **Health-gated search**: only `quota_exceeded` and `auth_invalid` park a source.
  A timeout merely cools down — one bad probe never permanently disables a source.
  When every source is parked the request returns a structured `failed`, not an
  empty success.
- **Scheduled probing** honours `scheduledEnabled`, `intervalMinutes`, the run and
  day budgets, and `concurrency` (capped at 4). The timer only ticks; settings
  decide whether anything is probed, and paid probes stay off by default.

### Update and rollback

- `packaging/launcher/updater.mjs` runs outside the server process (Windows locks
  the running executable, systemd owns the Linux service): verify → back up →
  stop → swap → start → health check → rollback.
- Checksums come from the release metadata digest rather than a co-downloaded
  `SHA256SUMS`: a tampered release can carry a matching fake sums file.
- Refuses downgrades, foreign architectures, path traversal and any archive entry
  that escapes the install root — all before a single file is touched.
- The backup always includes `master.key`; a database backup without it cannot
  decrypt stored provider credentials.
- `planRollback()` distinguishes "program only" from "restore the pre-update
  database", and refuses the unsafe case rather than pretending a program swap
  rewinds a migration.
- Docker never replaces its own image: `/api/admin/update/apply-plan` returns the
  pull/compose steps plus the warning that rolling back an image does not roll
  back migrations.

### Fixes carried from the catalogue audit

`minimax`, `metaso` and `metaso-mcp` are now in the catalogue (50 builtin adapters,
58 entries). `v0.1.5-beta.1` did not contain them, so its marketplace could not
create those three sources.

### Verification

663 Vitest (25 new), 6 health end-to-end cases (REST ↔ MCP ↔ scheduler), 16 updater
assertions against real archives and a real HTTP health probe.

## v0.1.5-beta.1 (2026-11-16)

Provider health management, measured MCP protocol reporting, Agent Skills
validation and update staging.

### Provider health

- Two probe kinds, kept separate: `connect` (free) and `search` (paid). Paid
  probes are **refused with 400** when disabled or when the budget is exhausted —
  never silently downgraded, because a downgrade reads as success.
- Causes are classified by what they mean operationally: `auth_invalid`,
  `forbidden`, `rate_limited`, `quota_exceeded`, `network`, `dns`, `tls`,
  `timeout`, `empty_results`. A quota problem is parked until the next UTC
  midnight; a rate limit waits for `Retry-After`. Retrying a quota-exhausted key
  in a minute only fails again and costs another request.
- A source with no credential is `unverified`, never `healthy`. A source that
  answers HTTP 200 with zero results is `degraded`, never `healthy`.
- Per-run and per-day budgets are checked *before* each request. The first
  implementation only checked the daily counter, so "check all" ignored
  `maxRequestsPerRun` entirely; that is fixed and covered by a test.
- Health is stored in its own table (`provider_health_checks`, migration 0003) so
  a failing probe can never be mistaken for "disabled by the administrator".
- P50/P95 come from live search traffic only; probes cannot inflate them.

### Health-aware failover

- `quota_exhausted` is terminal for the day: the key scheduler skips it instead of
  rotating to another key of the same exhausted account.
- Verified: one healthy + one failing source → `partial` with `failedSources`;
  all failing → `failed` with zero results.

### MCP protocol status (measured, not assumed)

- The installed SDK is `@modelcontextprotocol/server@2.4.0`; its
  `LATEST_PROTOCOL_VERSION` is `2025-11-25`. A real `initialize` with
  `2026-07-28` is **downgraded to 2025-11-25**. v0.1.5 therefore reports
  `revision2026Supported: false` and says why, instead of claiming compatibility
  by changing a version string. Evidence: `docs/mcp-protocol.md`.
- Update checking consults only the npm registry and the GitHub releases API,
  caches for 30 minutes, and reports `unknown` rather than "up to date" on
  failure. Protocol, SDK and application updates are three separate kinds.
- `tools/list_changed` is deliberately not sent: the tool catalogue is static, so
  the notification would ask clients to refetch a list that cannot have changed.

### Agent Skills

- Local validator for the Agent Skills specification: name pattern, length and
  directory match; description and compatibility bounds; reference containment;
  symlink escape; SKILL.md size. All three bundled skills validate clean.
- `GET /api/admin/skills` returns validation, `/:name` returns content,
  `/:name/export` streams a ZIP built in-process. Path traversal is refused
  (400) before any path is built.

### Updates

- Checksums come from the **release metadata** (GitHub's server-side `sha256:`
  digest), not from a `SHA256SUMS` file shipped next to the download: a tampered
  release would carry a matching tampered sums file.
- Size mismatch, missing digest and hash mismatch all refuse the package and
  delete the staged file. Docker is refused outright.
- Installing is intentionally not implemented in the server process: replacing a
  running executable is the launcher's job.

### Web

- New 健康监控 tab: status badges, P50/P95, success rate, key availability, the
  probe budget, and a per-source probe button. `unverified` is a first-class
  state, never rendered as healthy.

### Known gaps in this beta

- Skills over MCP (`skills/list`, `skills.attach()`) is not implemented: the SDK
  ships no runtime export for that extension and it is experimental.
- The launcher-side installer (replace + rollback) is not implemented yet; only
  check, download, verify and stage exist.
- No vendor credentials exist in this environment, so `documented` sources remain
  `unverified` rather than healthy.

## v0.1.4-beta.6 (2026-11-16)

Security release. Supersedes beta.5.

**Security: cross-token task access (severe).** `GET /api/search/tasks/:id`
authenticated the caller but discarded the actor, and `POST .../cancel` had no
ownership check, so any API token could read another caller's query and results
and cancel their in-flight search. Verified against the published beta.5
package: `bob reads alice's task: HTTP 200 leaked=YES`. beta.6 enforces ownership
and answers 404 (not 403) so task existence does not leak either.

Also fixed in this release:

- **Deep search lied about success.** All providers failing produced
  `200 / completed / 0 results` and a `completed` task row. It now returns
  `failed` with per-query errors when nothing succeeded and `partial` when some
  did; a failed response no longer triggers the summary model.
- **Cache key was incomplete**: `includeRaw`, `perProviderLimit`, `timeoutMs`,
  `capability` and the provider configuration were missing, so a narrower request
  could read a richer cached entry and a reconfigured provider could replay stale
  results. Added a per-provider configuration fingerprint.
- **Cache hits recorded `completed` unconditionally**, inflating the dashboard
  when the cached response was `partial`. The cached status is preserved and
  cancelled runs are not cached.
- **Explicit model ids bypassed `enabled`** — a disabled (or wrong-kind) model
  could still be invoked and billed by a normal search request. Added
  `getEnabled()`; the admin test endpoint keeps `get()` for pre-enable probing.
- **Launcher lifecycle**: non-atomic lock, PID-only identity (PID reuse could
  signal an unrelated process), stale locks blocking startup, `--stop` reporting
  success while the server survived, an orphaned child after a health timeout,
  and config written before the port check. Now O_EXCL locking, `/proc` start-time
  identity, atomic reclaim, verified stop (exit 8, lock kept), and a killed child
  on health timeout.
- **Dashboard success rate** counted user cancels as failures and partials as
  successes. It now covers finished non-cancelled runs only, with
  partial/failed/cancelled exposed separately.

Release automation: the release workflow now has a gate job that refuses to build
unless the Tag's commit is on `main` and both the CI and Docker runs for that
exact SHA are green; every build job checks out the gated SHA; a pre-existing
Release with assets aborts the run; published assets are downloaded again and
verified against `SHA256SUMS`; and a GHCR image is built, started, health-checked
and only then pushed — never tagged `latest` for a prerelease.

Tests: 572 Vitest, 17 Playwright, 12 launcher-lifecycle assertions (new Windows
CI job).

## [0.1.4] - 2026-11-15

Provider expansion round. Every entry below is either implemented and covered
by contract tests against the vendor's documented wire format, or explicitly
left unverified. No provider is marked `live_tested` without a recorded run.

### Added — native search providers (first batch)

| Type | Endpoint | Auth | Documented response |
|---|---|---|---|
| `tencent-yuanbao` | `POST https://wsa.tencentcloudapi.com/` (SearchPro, 2025-05-08) | TC3-HMAC-SHA256, SecretId+SecretKey pair | `Response.Pages[]`, each a JSON string |
| `doubao` | `POST https://open.feedcoopapi.com/search_api/web_search` | Bearer | `Result.WebResults[]` (PascalCase) |
| `deepseek-search` | `POST https://api.deepseek.com/v1/tools/search` | Bearer | `results[]` |
| `qianfan-search` | `POST https://qianfan.baidubce.com/v2/ai_search/web_search` | Bearer | `references[]` |
| `anysearch` | `POST https://api.anysearch.com/v1/search` | optional Bearer | `{code,data:{results[]}}` |

- All five are `raw_search`: they return verifiable web pages, never an AI
  answer. `deepseek-search` uses the standalone search API, not chat completions.
- Tencent uses a **credential pair** stored as one JSON credential, so key
  rotation switches both halves atomically. A single half is rejected.
- Quota vs auth is mapped per vendor: Volcengine 10406/10408/10409/10410/10412
  and DeepSeek 402 are quota errors, not invalid keys.
- Date parsing for Tencent is pinned to +08:00 because the source string has no
  timezone; otherwise the same value would differ between a local and a CI run.

### Added — capability contract

- `ProviderCapability = raw_search | grounded_answer`, `GroundedAnswer` with
  `citations[]` and `toolInvoked`.
- `SearchResponse.answers[]` is a separate channel from `results[]`; MCP and the
  lab UI surface it separately. An answer with `toolInvoked=false` or no
  citations is never presented as search success.

### Added — web configuration

- Catalog entries now carry declarative `fields[]` (text/password/number/select/
  boolean), rendered per provider instead of one generic JSON box.
- Saving a provider with credential fields creates the key in the same action;
  pair credentials are joined into one key value.
- Catalog cards show capability (`原始检索` / `模型联网`), `凭证对`, and
  `可无 Key 使用` badges.

### Changed

- `baidu` catalog entry now points at `qianfan-search` (the actual official
  endpoint) instead of claiming no API exists.
- `metaso` stays `planned`: only the path and query params could be verified;
  host, auth header and response shape could not, so no adapter was written.

### Not done (honest gaps)

- Gemini / Grok / MiMo / Bailian / MiniMax / Stepfun grounded adapters: not
  implemented in this round.
- Generic MCP search: not implemented.
- Metaso: protocol partially verified only.
- No provider is `live_tested`; no real key was used.

## [0.1.3] - 2026-11-14

Development round focused on real integration options, honest docs and CI
runtime hygiene. No security threshold was relaxed and no provider was promoted
to `live_tested` without a real credential.

### Added

- **Legacy Search Hub compatibility adapter** (`search-hub-legacy`): calls an
  independently deployed old instance via `POST /api/search` (path and mode
  configurable), forwards `freshness`/`language`, accepts both `{results:[]}`
  and `{data:{results:[]}}` envelopes, and maps 401/403/429/5xx/timeout to the
  existing provider error codes. Read-only and reversible: deleting the provider
  instance reverts the integration; nothing is written to the old service. 16
  contract tests use a local fake; **no real 44475 instance was contacted**.
  See `docs/legacy-44475-integration.md`.
- **Provider contract coverage** for the compat adapter plus explicit tests for
  Chinese language mapping, freshness forwarding and URL preservation.

### Fixed

- **Caller cancellation was reported as a network error.** `safe-fetch` mapped
  an aborted caller signal to `network` (`retryable: true`), which could mark a
  healthy provider/key as failing and retry a request the caller had abandoned.
  It now maps to `cancelled` (`retryable: false`), with a regression test.

### Changed

- **GitHub Actions runtime**: checkout/setup-node/upload-artifact/pnpm-setup/
  buildx/build-push upgraded to versions that declare `using: node24`, removing
  the Node.js 20 deprecation warning without changing any gate.
- **Version** bumped to `0.1.3` across the workspace, API `/api/health` and the
  three SKILL.md metadata files.
- **Docs**: local Docker (still unavailable on this Windows host) and CI Docker
  (executed, 24/24 PASS in run 43582011942) are now stated separately in every
  status document; no unverified provider was upgraded.

## [Unreleased]

### Planned

- PostgreSQL support behind the existing repository boundary.
- Redis-backed key scheduling for multi-instance deployments.
- Persistent embedding index (vector store) for document retrieval.
- Additional verified provider adapters (only after a recorded live test).
- SSE streaming for summaries and long-running deep research.

## [0.1.2] - 2026-11-13

Security and release-readiness pass. The theme is "prove it or mark it blocked":
proxy egress gets an explicit trust boundary, database snapshots use the SQLite
online backup API, and the acceptance matrix is generated from evidence instead
of being counted by hand.

### Added

- **Outbound proxy support with a default-deny trust model.**
  `SEARCH_HUB_PROXY` / `SEARCH_HUB_NO_PROXY` / `SEARCH_HUB_PROXY_TRUST`
  (the `SEARCH_HUB_OUTBOUND_*` spellings remain accepted aliases), plus an
  explicit `SEARCH_HUB_PROXY_FROM_ENV` opt-in for conventional
  `HTTPS_PROXY`/`NO_PROXY`. Only `http://` and `https://` forward proxies
  are accepted. While the proxy is untrusted (default), loopback, RFC1918,
  CGNAT, link-local, `.local`/`localhost` and cloud metadata destinations are
  rejected **before** any proxy request, even if they are on the private host
  allowlist. Proxy credentials are never logged; `/api/health` exposes only
  mode/trust, and the full policy is admin-only at `/api/admin/outbound`.
- **Provider expansion**: Tavily and Bocha adapters implemented strictly from
  their official docs (official endpoint probed with an invalid key to confirm
  reachability and the error envelope), plus a re-audit of Brave and SearXNG.
  All four stay `documented`; Hacker News remains the only `live_tested`
  provider. Per-vendor language/freshness mapping tables are in
  `docs/provider-matrix.md`.
- **Model protocol matrix**: `kind` × `providerType` combinations that cannot
  work (e.g. `embedding` + `cohere`) are rejected at the edge with
  `validation_error` instead of failing at request time.
- **SQLite online backup**: `GET /api/admin/backup` now uses
  `better-sqlite3` `db.backup()` (Online Backup API), normalises the copy to
  `journal_mode=DELETE`, runs `PRAGMA integrity_check`, stamps
  `user_version`, and publishes atomically (a failed or killed backup leaves
  no file under the final name). Added
  `POST /api/admin/backup/verify` (raw `.db` upload, 64 MB cap, header +
  integrity + migration check, temp copy always deleted) and
  `POST /api/admin/maintenance/checkpoint`.
- `tests/scripts/backup-restore.mjs`: end-to-end drill — snapshots under
  concurrent searches, `integrity_check` and ciphertext-only API keys on every
  download, restore into a fresh directory with `master.key`, newer-schema
  refusal at boot (exit code + log assertion), and failure handling.
- `tests/unit/migrate-guard.test.ts` / `tests/integration/backup.test.ts`:
  migration-version refusal, snapshot consistency under 50 concurrent writes,
  verify endpoint (valid/newer/foreign/garbage/oversized/unauthenticated).
- **Newer-schema refusal**: the API refuses to start when `_migrations`
  contains a migration this build does not ship, instead of silently running
  older code against a newer database.
- `scripts/secret-scan.mjs`: working-tree + git-history credential scan with a
  narrow allowlist for test fixtures; fails the release gate on any hit.
- `docs/ac-matrix.json` + `scripts/ac-matrix.mjs`: the single source of truth
  for AC-01…AC-16, exactly 16 rows, one overall status each, with generated
  counts in `docs/ac-matrix.md`.
- `tests/scripts/search-quality.mjs`: repeatable quality harness (Chinese
  current affairs, English tech, exact phrase, recent) reporting per-source
  counts, valid/unique URLs, duplicate rate, latency and failures without
  subjective ranking.
- `docs/provider-matrix.md`, `docs/provider-plugin-guide.md`,
  `docs/release-checklist.md`, GitHub issue/PR templates.

### Fixed

- **IPv4-mapped IPv6 SSRF bypass**: `http://[::ffff:127.0.0.1]/` and
  `[::ffff:169.254.169.254]` were not recognised as blocked because the URL
  parser normalises the host to `::ffff:7f00:1`. The address guard now decodes
  the hexadecimal mapped form.
- **Blocked destinations were reported as `auth_invalid`**: a
  `SearchHubError("blocked")` hit the generic HTTP-status mapper and became a
  credential error, which could mark a key invalid and mislead operators. The
  provider HTTP layer now passes `blocked` / `bad_request` / `unsupported`
  through unchanged.
- **Database snapshot raced concurrent writers**: replacing
  `wal_checkpoint + readFile` with the Online Backup API removes the window
  where a writer could append to the WAL after the checkpoint.
- Proxy 407/502 errors are mapped to explicit, credential-free messages instead
  of a generic `network` error.
- **Model credentials could surface through vendor error bodies.** Gemini sends
  its key as `x-goog-api-key`, which `SafeFetch`'s header redaction list does not
  cover, so an upstream (or a proxy in front of it) that echoed that header put
  the plaintext key into `model_configs.last_test_error` — and therefore into
  `/api/admin/models`, `/api/admin/backup` snapshots and search
  `stats.errors[].message`. Every model adapter now scrubs its own key (and the
  known credential shapes) before an error leaves it, and the model test endpoint
  scrubs again before persisting. Covered by
  `tests/integration/model-security.test.ts`.
- **A model Base URL that can never work is now refused at save time.**
  Private / reserved / metadata destinations were stored successfully and only
  failed later as a silently degraded search. `POST /api/admin/models` and
  `PATCH /api/admin/models/:id` now reject them with `blocked` and an actionable
  message unless the host is on `settings.security.privateHostAllowlist`; the
  runtime check is unchanged and still applies per request (and to configs
  imported through `/api/admin/config/import`).
- **A degraded model stage lost its timing metric.** `withWarning` wrote
  `rerankMs` / `embeddingMs` / `summaryMs` onto `stats` instead of
  `stats.timing`, so the UI, the types and the dashboards always read
  `undefined` on the failure path. The elapsed time is now recorded where it is
  read.

### Changed

- All workspace packages and the API version are `0.1.2`.
- **Unimplemented provider types now return `400 not_implemented`** instead of
  `501 unsupported`: AC-14 explicitly requires a 4xx with a code, and a 501 is
  a server error that looks like a bug.
- **Model key masks are first-4 + last-4** instead of last-4 only, so two keys
  with the same suffix are distinguishable (AC-03).
- Provider count is now 7 implemented adapters (Brave, SearXNG, Hacker News,
  Tavily, Bocha, Generic HTTP, Mock); the catalog stays at 27 entries and the
  "catalog entry ≠ available adapter" rule is unchanged.
- `docs/acceptance-report.md` now defers the AC tally to the generated
  `docs/ac-matrix.md`; the matrix is the only place statuses are counted.

### Known limitations

- **Docker image build / Compose / container restart remain BLOCKED** in this
  environment: `com.docker.service` cannot be started without administrator
  rights and `wsl.exe` is blocked by the host security policy. A Linux/CI
  verification workflow and script are provided; they have not run here.
- **Tavily / Bocha / Brave / SearXNG are `documented`, not `live_tested`**:
  no keys or reachable instance were available. Contract tests do not prove a
  vendor account works.
- **Proxy mode cannot pin the destination IP**: with an HTTP proxy the proxy
  resolves the target, so a DNS-rebinding race is theoretically possible unless
  the operator declares `trusted-networks` and enforces egress control at the
  proxy.
- Agent Skills still have no real agent-client execution evidence.
- **AC-05 elapsed-time budget is PARTIAL**: the invariant parts (per-key peak,
  RPM window, daily quota, queue timeout) hold, and the scheduler-level budget
  lands at ratio 0.97–1.06, but the end-to-end 100-request burst measured
  1.22–1.30 on a loaded host. The claim is not upgraded.
- **AC-14 rejected-types path is fixed, but the source of the 501 was shared**
  with `unsupported` (still 501 for genuinely unsupported protocol requests).

### beta.6 stability audit (2026-11-16)

Seven defects found by reproducing behaviour on a running instance, not by
reading code alone. Full evidence in `docs/beta6-audit.md`.

- **Deep search lied about success.** `runDeep` treated a `status:"failed"`
  sub-response as usable, so every-provider-down returned `200 / completed / 0
  results`, and the task row said `completed`. It now keys on the sub-query
  index, returns `failed` with per-query errors when nothing succeeded, and
  `partial` when some did. A failed response no longer calls the summary model.
- **Cache key was incomplete** (missing includeRaw, perProviderLimit, timeoutMs,
  capability, and the provider configuration itself). A `includeRaw:false`
  request could hit an entry written by `includeRaw:true`; changing a provider's
  endpoint or search parameters reused stale results. The key now includes those
  fields plus a per-provider configuration fingerprint.
- **Cache hits recorded `completed` unconditionally**, inflating the dashboard
  even when the cached response was `partial`. The cached status is preserved and
  cancelled runs are no longer cached.
- **Explicit model ids bypassed `enabled`.** `chatModel(id)` used `get()`, so a
  disabled model could still be invoked (and billed) by a normal search request.
  Added `getEnabled()`; the admin test endpoint keeps `get()` so an operator can
  probe before enabling.
- **Cross-token task access (severe).** `GET /api/search/tasks/:id` authenticated
  but ignored the actor (`void actor;`), and `cancel()` had no ownership check:
  any token could read another caller's query and cancel their search. Both now
  enforce ownership and answer 404 rather than leaking existence.
- **Launcher lock/stop were unsafe.** Non-atomic lock (two double-clicks both
  proceeded), PID-only identity (PID reuse could signal an unrelated process),
  stale locks that blocked startup forever, and `--stop` printing success then
  deleting the lock even when the process survived. Now: O_EXCL lock, start-time
  identity check, atomic reclaim, verified stop (exit 8 + keep the lock on
  timeout), signal forwarding, and a killed child on health timeout.
- **Dashboard success rate counted user cancels as failures** and partials as
  successes. The rate now covers finished non-cancelled runs only, with partial /
  failed / cancelled exposed separately.

Tests: 572 Vitest (14 new in `tests/integration/beta6-stability.test.ts`),
17 Playwright, plus `packaging/launcher/lifecycle-test.mjs` (12 assertions) wired
into a new Windows CI job.

### MiniMax, Metaso and standalone packages (2026-11-15)

**MiniMax Coding Plan** — protocol taken from the official MCP source rather than
the marketing docs: `POST {host}/v1/coding_plan/search`, body `{q}`, headers
`Authorization: Bearer` + `MM-API-Source: Minimax-MCP`. The HTTP status is not
enough: `base_resp.status_code` decides, and the adapter distinguishes
1004 (key/host **region mismatch**) from 2038 (no Coding Plan entitlement) so a
permission problem is never reported as an invalid key.

**Metaso (秘塔)** — `POST https://metaso.cn/api/v1/search` with Bearer auth and
`q/scope/size/page`; response `webpages[]`. Confirmed by a real unauthenticated
call returning HTTP 200 with `{"errCode":2005}`, so errors are read from the body.
A non-`webpage` scope is warned about (proprietary index, not the web). A second
provider `metaso-mcp` reuses the Generic MCP client with 秘塔 presets and never
contacts the legacy deployment.

**mock is now `mock_verified`** — a test double is not a vendor integration. The
verification scale is `live_tested` / `mock_verified` / `documented`, and the UI
labels them separately.

**Standalone packages** — `SearchHub.exe` (Node SEA) plus a bundled runtime for
Windows, `tar.gz` + systemd template for Linux x64/arm64. The server is a child
process on purpose: `better_sqlite3.node` cannot load from a SEA blob. The
package ships one bundled `server.mjs` (pnpm's 90k-file tree exceeds the ZIP
entry limit) and a dependency-free ZIP writer with correct CRCs.

**Acceptance** — `packaging/verify-package.mjs` launches the extracted package
with node/pnpm removed from PATH and checks health → setup → provider → REST →
MCP initialize/tools.list/tools.call → DB + master.key → stop → restart
persistence. The `Release packages` workflow runs it on real Windows and Linux
runners before any prerelease is published.

### Provider ecosystem, Generic MCP and UI pass (2026-11-15, same PR)

**22 new native providers** (all `documented`, contract-tested, no live credential):
perplexity-search, youcom, jina-search, parallel-search, linkup-search, serpapi,
searchapi, dataforseo, openai-websearch, anthropic-websearch,
mistral-websearch, perplexity-sonar, naver, kakao, yandex, wikipedia,
crossref, openalex, pubmed, semanticscholar, europepmc, gdelt.
Plus `github`, `arxiv`, `duckduckgo` (Instant Answer only) and `generic-mcp`.

Protocol details that were easy to get wrong:

- Perplexity's retrieval endpoint and Sonar are different products, so they are
  two providers; an AI answer can never appear in the web-result list.
- DataForSEO needs Basic `login:password` and a task array; a bearer token is
  rejected, so the adapter builds the header itself.
- Naver needs two headers (client id + secret); Kakao uses `KakaoAK` and exposes
  `meta.is_end` as the authoritative stop signal.
- OpenAlex returns `abstract_inverted_index`; it is rebuilt into text or the
  snippet would be raw JSON.
- GDELT's `seendate` is `YYYYMMDDTHHMMSSZ` and is converted to ISO.
- Crossref/OpenAlex/PubMed need no credential and were **live-tested**; their
  manifest status is now `live_tested` with recorded output.

**Generic MCP** (`packages/providers/src/mcp-client.ts` + `generic-mcp.ts`):
Streamable HTTP only — initialize → notifications/initialized → tools/list →
tools/call, JSON and SSE responses, `mcp-session-id` handling, tool
auto-discovery, `{{query}}`/`{{limit}}` argument templates and configurable
result field mapping. No stdio transport: a web user must not be able to make
the server spawn a local process.

**Marketplace**: `POST /api/admin/providers/bulk` with `install_all`,
`enable_ready` (paid sources require explicit cost confirmation) and
`disable_all`; every action returns per-item results. The UI gained category and
auth filters, a sticky batch bar and a first-run empty state on the dashboard.

**Provider form**: scheduling, account budget and adapter JSON are grouped behind
a 高级设置 toggle; Generic HTTP/MCP/mock/legacy open it automatically because
those cannot be configured without it. Search parameters stay visible.

**Modes**: `web` / `grounded` / `research` are enforced server-side so REST, MCP
and Skills cannot drift.

**E2E**: the suite hit the production per-IP rate limit (300/min) after ~15
tests, which surfaced as raw JSON in the SPA; the test server now raises
`SEARCH_HUB_RATE_LIMIT_PER_MIN` and `login()` reports the redirect target instead
of a silent locator timeout.

Tests: 548 Vitest, 17 Playwright.

### Marketplace and Provider Manifest (2026-11-15, same PR)

- **Provider Manifest**: one declarative document per provider (capability, auth,
  endpoint, supported parameters with vendor limits, pagination, account-quota
  scope, result mapping, docs, verification status), derived from the catalog so
  the two cannot disagree, served at `GET /api/admin/providers → manifests`.
  Data only: a manifest cannot carry code or execute anything.
- **Per-source search parameters**: new `search_config_json` column (migration
  0002) with targetResults / maxPages / maxRequestsPerSearch / region /
  safeSearch / searchDepth / includeDomains / excludeDomains / sort / locked.
  Unsupported parameters are rejected with the vendor's reason instead of being
  stored and ignored.
- **Real pagination**: Brave offset paging (page size 20, max 10 pages) fetches
  50 rows in 3 requests, stops early on a short page and reports the rows and
  requests actually used. Serper pages `page` 1-based. Non-paginated vendors
  (Exa, Firecrawl, GitHub, arXiv) declare it and refuse `maxPages`.
- **Marketplace**: fresh installs have zero providers; batch install never
  auto-enables a source that lacks its credential; batch enable skips not-ready
  instances with a stated reason; `ready` / `notReadyReason` in the summary.
- **UI**: providers split into 我的搜索源 / 搜索源市场 with selection, sticky
  batch bars and a first-run empty state; the form renders search parameters
  from the manifest so unsupported fields never appear.
- **Search presets**: `web` (raw_search only), `grounded` (grounded only),
  `research` (both), enforced server-side for REST, MCP and Skills alike.
- **New adapters**: exa, firecrawl, serper, github (vertical), arxiv (vertical).
  All `documented` with contract tests; no real credential was used.

### Grounding review round (2026-11-15, same PR)

**状态契约.** `GroundedAnswer.status` 现在是五个独立事实，而不是一个布尔：
`toolProvided` / `toolInvoked` / `retrievalSucceeded` / `hasVerifiableSources` /
`answerSupported`。除 `toolProvided` 外都允许 `"unknown"`；证据不足时返回 unknown，
不猜 true/false。

- **Gemini**: 保留 `webSearchQueries`、`searchEntryPoint`、`groundingChunks`
  与 `groundingSupports`。`groundingSupports[].groundingChunkIndices` 指向 chunk
  下标，因此引用**按厂商顺序保留、不去重**——去重会让下标整体错位并高亮错句子。
  缺 `groundingMetadata` 时是 `unknown`，不是 false。
- **Google Search Suggestions**: 厂商 HTML **不进入** API 响应或管理后台。解析成
  `{label, url}` 纯数据后由前端渲染自有元素，`vendorHtmlWithheld=true` 明示。
- **Grok**: 同时采集 `url_citation` 注解、`web_search_call.action.sources` 和响应级
  `citations[]`；只有文本锚定的注解才算 `answerSupported=true`（xAI 明确说明
  all-citations 是审计轨迹，不证明支撑）。
- **MiMo**: annotations 存在即视为调用了工具（即使没有 URL），未提供时如实标 false；
  非流式与流式的差异写进适配器注释，本适配器只发非流式请求。
- **百炼**: 用 `usage.plugins.search.count` 判断是否联网，用
  `search_info.search_results` 判断是否取到来源，二者都不存在时是 unknown。
  兼容通道拿不到来源这一事实仍在文档与目录说明里。
- **StepFun**: `position` 改为 `upstreamRank`，不再冒充
  `upstream.providerName`（此前 UI 会显示“来源：rank 1”）。该字段贯穿
  去重、RRF、REST 与 MCP，`source` 始终是真实的 provider 名。

**账户级额度.** 新增 `AccountQuotaRegistry`：显式配置 `accountGroup` +
`accountRpmLimit` / `accountDailyQuota` 后，同组的多把 Key 共用一份预算，N 把 Key
不再等于 N 个账户。预算在取 Key 槽位之前扣减，取不到 Key 时退回；耗尽时返回
`quota_exceeded` 而不是 `no_available_key`。**明确限定为单进程**：多副本各自计数，
不是分布式协调，UI 文案与文档都这样写。

**Web 实验台.** 分别展示原始结果、AI 回答、五项联网状态、实际引用、无来源/
未联网/状态未知三种警告、模型名、单次耗时与脱敏错误；Sources 区块标出每条引用
支撑了哪几段文本（来自 `groundingSupports`）。

**测试.** 新增 12 项：grounding 映射、support 越界丢弃、XSS 净化（script/onclick/
javascript: 全部拒绝）、StepFun 排名、账户组共享预算/隔离/退款、REST 状态字段、
MCP `upstreamRank` 透传。Playwright 新增 2 项：账户额度保存回显、实验台初始状态。

### Second batch — AI grounded search (2026-11-15)

Added five providers after re-checking each vendor's current official docs:

| Type | Capability | Verified protocol |
|---|---|---|
| `gemini` | grounded_answer | `generateContent` + `tools:[{google_search:{}}]`; citations from `groundingMetadata.groundingChunks[].web` |
| `grok` | grounded_answer | `POST /v1/responses` + `tools:[{type:"web_search"}]`; `url_citation` annotations + `web_search_call.action.sources` |
| `mimo` | grounded_answer | `POST /v1/chat/completions` + `tools:[{type:"web_search",force_search,max_keyword,limit}]`; `message.annotations[].web_search tool call` |
| `bailian` | grounded_answer | DashScope native `text-generation/generation` with `result_format=message` + `enable_source`; `search_info.search_results[]` |
| `stepfun` | **raw_search** | `POST /v1/search`; `results[]` with url/position/title/time/snippet/content |

Protocol points that would have been wrong if copied from older docs:

- Gemini uses `google_search`, not the legacy `google_search_retrieval`; the model id is user-editable because Google retires ids frequently.
- Grok: `web_search` being available does not mean it ran. The adapter requires an
  actual `web_search_call` item, otherwise `toolInvoked=false`.
- MiMo's `tools[]` entry is `{type:"web_search"}` (not a function tool).
- Bailian's OpenAI-compatible channel **cannot return sources**; the adapter uses the
  native endpoint because citations are the whole point.
- StepFun explicitly documents that some models cannot use a built-in `web_search`
  tool, so its standalone search endpoint is `raw_search`, not grounded.

Capability contract: `SearchResponse.answers[]` stays separate from `results[]`;
MCP `search_web` and the lab UI render an answer with `toolInvoked=false` or empty
citations as an explicit warning, never as search success.

Not implemented, with reasons: `minimax` (official web search is a local stdio MCP
launched via uvx — accepting that from a browser user would be command injection),
`metaso` (only path + query params verified).

Fixes carried in this round (see the first part of the PR):

- Editing a provider could lose a newly typed API key; credential actions are now explicit
  ("keep" / "add a key for rotation") and editing never silently overwrites a key.
- Switching provider type kept the previous Base URL/config/credential; switching now
  resets to the new provider's defaults and asks first when there is unsaved input.
- Provider + first credential are written in one transaction, so a failed key write
  cannot leave a provider that can never authenticate.
- Tencent `mode` submitted as a string from the form is coerced (it silently fell back to 0).
- TC3: base URL must be https (loopback http allowed only for tests), no path/query/userinfo,
  non-443 ports rejected, and a skewed local clock fails fast instead of causing AuthFailure.
- Browser E2E now fills a credential, creates, edits, rotates and verifies masking.

### Live-provider hardening (PR #2, 2026-11-15)

- Environment `provider-live` now uses Selected branches (**main only**) and
  `can_admins_bypass: false`. Verified: a `workflow_dispatch` from a non-main
  branch is rejected before any Secret is injected.
- Removed the `--key` CLI option from `provider-live.mjs`; credentials come
  only from the environment. Shared redaction (`redact-secrets.mjs`) scrubs
  literal, Bearer, URL-encoded, base64 and known-prefix key shapes from every
  printed line, and `scrub-provider-logs.mjs` scrubs the log files **in place
  before** they are uploaded as artifacts (fail-closed: no upload if scrubbing
  fails). CI runs through `pnpm exec tsx` so no re-exec child holds the key.
- Documented the six leak paths and the residual risk of arbitrary transformed
  credential echoes; a dedicated revocable test key is required.
- SearXNG acceptance no longer requires three runs to differ: A (interface
  availability) + B (real upstream request and failure reporting) are the
  gates, C (cache behaviour) and D (domain breadth) are observations only.
- Legacy 44475 identification is explicitly non-destructive: metadata first,
  search calls gated behind separate authorisation because they may consume
  quota, update statistics and populate caches.
- Added an evidence-level ladder: L1 adapter live verification must not be
  reported as L2/L3 REST/MCP full-chain verification.

### PR #1 compatibility review (2026-11-14)

- **Protocol honesty**: `search-hub-legacy` now has a closed `transport`
  allow-list (`rest` only). Any other value fails with `unsupported` (501)
  instead of silently falling back; MCP compatibility is explicitly documented
  as a separate, unimplemented adapter.
- **Upstream attribution preserved**: gateway rows carry
  `upstream: {provider, providerName, source, sources}` copied verbatim from the
  old service, through dedupe, fusion and `SearchResult.sources[]`. Nothing is
  inferred from the URL/domain; absent upstream fields stay absent.
- **Envelope status**: `status:"failed"` (even with `results: []`) is an error,
  `status:"partial"` keeps rows but marks the search `partial` with a per-provider
  warning, and `status:"completed"` with zero rows stays a legitimate empty
  result. A failed envelope is never reported as success.
- **Cancellation accounting**: a caller abort now releases the key lease as
  cancelled without incrementing failure counters, and the acquire path checks
  for an abort after the wait, so a late lease cannot leak. Fixed in
  `fanout.ts`; covered by a scheduler regression test and an API integration test.
- **Networking docs/UI**: the base-URL hint and `docs/deployment.md` explain
  container vs host vs cross-server addresses, and state that the SSRF
  allowlist is an explicit declaration, not a workaround.
- Tests: 417 (23 legacy contract + 5 legacy API integration + cancellation).

### Verified in GitHub Actions (2026-11-14)

- Repository: <https://github.com/alicia1030su/search-hub> (public, default branch `main`).
- `CI`: quality, build, Playwright E2E and security/secret-scan jobs all green.
- `Docker`: image built on ubuntu-latest (`search-hub:ci`, 506 MB) and the
  11-item container acceptance passed **24/24**: compose start, non-root uid
  1001, web bundle, health, setup token, administrator initialisation, a real
  Hacker News search, key masking, restart consistency, persistence, resource
  footprint, crash recovery (SIGKILL → RestartCount 0→1), Trivy
  (CRITICAL=0/HIGH=0) and MCP (9 tools, real URL, REST parity, 401).
- The first two Docker runs failed for **test** reasons, both fixed rather than
  waived: `docker kill` is an explicit stop (restart policy correctly ignores
  it) and the MCP payload is a JSON string with escaped slashes. Neither the
  Trivy threshold nor any security check was relaxed.
- Security settings: secret scanning + push protection + Dependabot alerts
  enabled; `GITHUB_TOKEN` default read-only; `main` requires five checks and
  forbids force pushes/deletions.

## [0.1.1] - 2026-11-13

Production-readiness pass: the main fixes are the ones that only show up when
the service actually talks to a real network or a clean production install.

### Fixed

- **Every real outbound HTTP call failed on Node 22.** The guarded DNS
  `lookup` returned a single address while `autoSelectFamily` requests the
  `all: true` array form, so provider calls died with
  `ERR_INVALID_IP_ADDRESS`. The lookup now honours both callback shapes, and
  the guarded dispatcher is covered by a regression test that hits a real
  local server.
- **First-run administrator preemption.** A fresh instance could be claimed by
  anyone who reached the port. It now always requires a one-time setup token:
  `SEARCH_HUB_SETUP_TOKEN` when set, otherwise a generated
  `<data>/setup-token` (0600) printed once to the log and deleted after
  initialization. Admin creation runs in a `BEGIN IMMEDIATE` transaction, so
  two concurrent setup requests cannot create two administrators.
- **MCP Host validation.** Only `Origin` was checked and the host comparison
  was self-referential, which left DNS rebinding open. Host and Origin are now
  validated before authentication against IP literals, `localhost`,
  `SEARCH_HUB_PUBLIC_URL` and `SEARCH_HUB_ALLOWED_HOSTS`; rejected requests
  get 403 without revealing whether a token is valid.
- **Reverse-proxy trust boundary.** `SEARCH_HUB_TRUST_PROXY=true` used to
  trust every peer, allowing `X-Forwarded-For` spoofing of login throttling
  and audit attribution. It now trusts only loopback proxies; other networks
  must be listed as explicit CIDRs.
- **Timeout errors were reported as `unknown`.** A per-provider timeout
  aborts through a combined signal whose reason is a plain `Error`; the
  fan-out now maps it to `timeout`. Circuit-breaker short-circuits report
  `circuit_open` instead of a misleading `server_error`.
- **MCP search results dropped provider attribution.** `provider`,
  `providerType`, `providerName` and `source` are now present in tool output.
- **Tokens created in the UI could not list sources.** `sources:read` is now
  offered and preselected; without it `get_search_sources` returned 403.
- **Docker image referenced `apps/web/dist` from the build context** instead
  of the build stage, so a clean `docker build` could not work. The runtime
  stage now copies the web bundle, server bundle, migrations and skills from
  the build stage.
- **`pnpm install --prod` followed by `pnpm build` was impossible** (the
  bundler needs dev dependencies). The documented order is now install →
  build → prod-only install → run the compiled server.
- **Backup guidance lost WAL data.** Copying only `search-hub.db` while the
  service runs drops recent writes; documented `db + -wal + -shm`, and added
  `GET /api/admin/backup` which checkpoints first.

### Added

- Hacker News adapter over the official Algolia API (keyless), **live-tested**
  through REST and MCP with real URLs and timestamps.
- `POST /api/admin/migration/legacy`: dry-run/apply migration of an older
  Search Hub provider list. It never reads or stores credentials, never
  overwrites existing names, and requires an explicit confirmation string.
- `GET /api/admin/backup` and `POST /api/admin/maintenance/checkpoint`.
- `skipCache` on `POST /api/search`; the search lab always sets it.
- `stats.degraded` on responses when an optional model stage fails.
- `queue_timeout` and `circuit_open` error codes.
- `peakInFlight` in key runtime snapshots (used by the quota tests).
- Production build: `scripts/build-server.mjs` emits
  `apps/api/dist/server.mjs` and `packages/mcp/dist/stdio.mjs`; the runtime no
  longer needs `tsx` or TypeScript sources.
- Verification scripts: `leak-scan.mjs`, `mcp-live.mjs`, `live-search.mjs`,
  `clean-install.mjs`.
- 38 new tests (177 total): three-tier quota peaks, 50-run fault matrix,
  model degradation, setup/Host/CSRF/proxy hardening, official MCP client over
  HTTP and stdio, legacy migration.

### Changed

- `/api/search` returns **503** when every provider fails; partial success
  stays 200 with `stats.partial=true` and `failedSources[]`.
- Documentation reconciled with the code: catalog counts (27 entries, 5
  implemented adapters), queue semantics, timeout defaults, error fields, and
  the fact that caching is implemented but disabled by default.
- Compose uses the named volume `search-hub-data` so the non-root container
  can write without a manual `chown`.

### Known limitations

- Docker image build and container restart could not be executed here: the
  Docker engine is unavailable (the WSL backend is blocked by the host
  security policy). See `docs/acceptance-report.md` for the evidence.
- Brave and SearXNG remain unverified (no key / no reachable instance).
- `kill -9` may lose up to the current 60s quota window; `SIGTERM` performs a
  clean checkpoint and close.

## [0.1.0] - 2026-11-13

First functional release: the full search loop works end to end, with keys,
providers, fusion, admin UI, REST, MCP, and Skills.

### Added

**Core search**

- Multi-provider concurrent fan-out with per-source timeout, global deadline,
  failure isolation, bounded retry budget, and client cancellation.
- URL canonicalization (tracking parameters, default ports, query ordering),
  exact and near-duplicate merging with source attribution, and Reciprocal Rank
  Fusion (`k` configurable, default 60).
- Deterministic `mock` provider with latency and failure injection for tests.

**Key management**

- Per-provider key pools with five scheduling strategies: round-robin, random,
  weighted random, least used, and failover.
- Atomic slot reservation; a bounded wait queue lets bursts queue instead of
  failing immediately while never exceeding the per-key concurrency limit.
- Per-key concurrency, RPM sliding window, optional daily quota, cooldowns,
  circuit breaker, and explicit error codes (`rate_limited`, `auth_invalid`,
  `quota_exceeded`, `no_available_key`, …).
- AES-256-GCM encryption with a master key from env or `data/master.key`;
  masked hints in every response.

**Providers**

- Brave (`X-Subscription-Token`), SearXNG (`/search?format=json`), declarative
  Generic HTTP/JSON, and Mock.
- Honest catalog of 26 entries with implementation and verification status;
  unimplemented entries cannot be created.

**Models (optional)**

- Chat: OpenAI-compatible, Anthropic, Gemini.
- Embeddings: OpenAI-compatible and declarative custom HTTP, with dimension
  validation and batching.
- Rerank: Cohere/Jina-compatible and declarative custom HTTP.
- Cited summaries (`[n]`), query rewriting for deep mode, embedding-based
  re-scoring, prompt-injection detection and untrusted-content boundaries.

**API and integrations**

- REST: `/api/search`, `/api/search/deep`, task inspection/cancel, provider
  catalog/health, dashboard, settings, tokens, logs, export/import.
- OpenAPI 3.1 document at `/api/openapi.json` plus a readable `/api/docs`.
- MCP server on the official v2 SDK (`@modelcontextprotocol/server` 2.4.0):
  modern 2026-07-28 envelope and legacy 2025-11-25 handshake, Streamable HTTP and
  stdio (proxy to REST), nine stable tools, bearer auth with scopes.
- Three Agent Skills: `search-web`, `deep-research`, `research-with-citations`.

**Admin UI**

- React 19 + Vite 8 + Tailwind 4, light/dark themes, Chinese default.
- Dashboard with timeline, provider health, key pool distribution, model stats.
- Provider catalog and forms (including Generic HTTP mapping validation),
  key panel with per-key test/disable/delete, model management with live tests,
  search lab with per-source timing, dedupe counts, fused ranks, rerank rank,
  summary citations, JSON copy/download, integrations and settings.

**Security**

- First-run administrator creation with no default password; scrypt hashing.
- HttpOnly session cookies plus CSRF headers on every admin mutation.
- Revocable, scoped, rate-limited bearer tokens, shown once.
- SSRF protection at DNS, connect, and redirect layers, with a metadata
  blocklist and an explicit private-host allowlist.
- Log redaction, secret-free config export, CSP and hardening headers.

**Operations**

- SQLite with WAL, ordered SQL migrations applied at boot, automatic retention
  cleanup, graceful shutdown flush.
- Dockerfile, `compose.yaml`, `.env.example`, health check, non-root runtime.
- GitHub Actions: lint, typecheck, unit/integration tests, migration smoke test,
  web build, image build and health check, Playwright E2E, dependency audit.
- Documentation set: architecture, API, MCP, Skills, provider guide, deployment,
  testing, security, product scope.

### Verified in this release

- 139 Vitest unit/integration tests pass.
- Playwright E2E passes (first run, login, providers, lab, theme, settings,
  integrations).
- `tests/scripts/smoke.sh` passes against a live instance.
- Load test: 100 concurrent searches with 2 keys × concurrency 2 complete
  without exceeding the per-key limit or leaking secrets.

### Not verified in this release

- Brave: no real subscription key; adapter tested against a local fixture.
- SearXNG: no live instance.
- AI / embedding / rerank: contracts tested against local mock servers only.
- Docker image build was **not executed** in the development environment
  (Docker daemon unavailable); the Dockerfile and CI job are provided but the
  image has not been built here.
- Multi-instance deployments are unsupported.

### Known limitations

- SQLite only; PostgreSQL is not implemented.
- Key quota state is per process; a crash can lose up to the current 60-second
  window and in-flight counts.
- No persistent vector index; embeddings apply per request.
- Single administrator; no multi-tenancy.
- In-process rate limiting does not coordinate across replicas.
