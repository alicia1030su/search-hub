# REST API

Base URL: `https://<your-instance>`. All requests and responses are JSON.
OpenAPI 3.1: [`/api/openapi.json`](../apps/api/src/routes/openapi-routes.ts) · human-readable list: `/api/docs`.

The standalone `shub` client uses these same endpoints; it does not expose a
second search implementation. See [CLI documentation](./cli.md).

## Authentication

Two mechanisms:

| Client | Mechanism | Notes |
|---|---|---|
| Admin UI | `sh_session` HttpOnly cookie + `x-csrf-token` header | Required on cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` |
| Integrations | `Authorization: Bearer sh_...` | Scopes: `search`, `sources:read`, `mcp:use`, `admin`. Bearer requests are not CSRF-checked because no ambient cookie is used. |

A cookie-authenticated mutation without `x-csrf-token` returns `403`, never a silent success. Bearer-token requests do not need CSRF. Tokens are shown once at creation; only their SHA-256 hash is stored.

## Backup and disaster recovery

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/backups/status` | Read-only DB/WAL/schema/key-source/latest-backup status; revalidates package SHA/size and current key fingerprint |
| POST | `/api/admin/backup/package` | JSON `{passphrase}` → verified streamed age-encrypted `.shbackup`; checksum is returned in `x-search-hub-backup-sha256` |
| POST | `/api/admin/backup/package/verify` | Multipart `file` (`.shbackup`) + `passphrase`; verifies without restoring |
| GET | `/api/admin/backup` | Legacy unencrypted `.db` snapshot; never includes `master.key` |
| POST | `/api/admin/backup/verify` | Raw `.db` upload (64 MiB cap) with integrity/schema/key-sample checks |

Admin-session mutations require CSRF. Package-verify processing order is rate limit → administrator scope → CSRF → temporary quota reservation → body consumption. Anonymous, missing-CSRF, low-scope and known-oversize requests create no temporary directory or file. Uploads use owner-randomized 0700 directories and 0600 files, heartbeat/stale cleanup, aggregate byte/concurrency quotas and Windows ACLs. Passphrases are body-only, trimmed, at least 12 Unicode code points, and never logged or audited.

Package verification returns six boolean business results: `formatOk`, `structuralOk`, `schemaCompatible`, `keyFingerprintMatch`, `ciphertextSampleDecryptable`, and `restoreReadiness`. `keyReadiness`, `sampleCount`, and `keyProofValid` provide supporting evidence; `sha256Match` is separate integrity evidence, not a seventh business result. Full contracts are in `/api/openapi.json`; operational steps are in [disaster recovery](./disaster-recovery.md).

## Error shape

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [{ "path": "limit", "message": "Too big: expected number to be <=100" }]
  }
}
```

| HTTP | code | Meaning |
|---|---|---|
| 400 | `validation_error` | Body/query failed validation, or no provider matched |
| 401 | `unauthorized` | Missing/revoked token or expired session |
| 403 | `forbidden` | Missing CSRF header, wrong scope, blocked destination |
| 404 | `not_found` | Unknown task/provider/key/model |
| 409 | `conflict` / `already_initialized` / `already_running` | Duplicate name, setup already completed, or another probe for the same provider is in flight |
| 429 | `rate_limited` / `quota_exceeded` | Login/token rate limit, or a local paid/anonymous/connect probe budget is exhausted |
| 501 | `unsupported` | Provider type has no adapter |
| 503 | `no_available_key` / `queue_timeout` / `circuit_open` / `server_error` | All keys unusable, every slot busy beyond the queue budget, the provider circuit is open, or every provider failed |
| 504 | `timeout` | Global deadline exceeded |

## Setup and auth

```http
GET  /api/setup/status
POST /api/setup                 {email,password,name,setupToken}   # token required on a fresh instance
POST /api/auth/login            {email,password}
GET  /api/auth/session
POST /api/auth/logout
GET  /api/health
```

`POST /api/setup` succeeds only when no administrator exists. Password minimum is 12 characters. If `SEARCH_HUB_SETUP_TOKEN` is set, the token is required in the body or `x-setup-token` header.

`GET /api/health` is public and returns version, uptime, setup requirement, provider counts, and encryption-key source (never the key). Its `outbound` object is deliberately coarse — `mode`, `proxyTrust` and `proxyTrustDeclared` only. The proxy endpoint, the `NO_PROXY` list/count and the `residualRisk` text are reachable by any unauthenticated caller, so they live behind admin auth at `/api/admin/outbound`; exposing them here would leak the internal egress topology (`proxy host:port`).

`GET /api/admin/outbound` (admin session, read-only) returns the full outbound policy: redacted proxy endpoint (`scheme://host:port`, never userinfo), the full `NO_PROXY` list and count, whether the private host allowlist is honoured for proxied requests, the one-line `residualRisk`, the controls the application performs and the ones only the proxy can provide. Configure it with `SEARCH_HUB_PROXY` / `SEARCH_HUB_NO_PROXY` / `SEARCH_HUB_PROXY_TRUST` — it is intentionally not mutable through the API.

## Runtime resources

```http
GET /api/admin/resources
```

This endpoint accepts **only an administrator `sh_session` cookie**. It does not
require CSRF because it is read-only. Any `Authorization` header returns `403`
before token verification; a missing, invalid, or expired session returns `401`.
The lookup never updates `lastSeenAt`, and an expired or malformed-expiry session is not deleted.
`process.uptimeSeconds` is nullable when the uptime source fails; the reason appears in `unavailable`.

```json
{
  "schemaVersion": 1,
  "sampledAt": "2026-11-22T00:00:00.000Z",
  "process": {
    "platform": "win32",
    "nodeVersion": "v22.22.2",
    "uptimeSeconds": 1234,
    "memory": { "rssBytes": 123456789, "heapUsedBytes": 45678901, "heapTotalBytes": 98765432, "externalBytes": 1234567, "arrayBuffersBytes": 234567 },
    "sources": { "rss": "node_process", "heapUsed": "v8", "heapTotal": "v8", "external": "v8", "arrayBuffers": "v8", "uptime": "node_process" }
  },
  "activity": {
    "activeSearches": 2,
    "activeProbes": 1,
    "queue": { "total": 4, "providerKey": 2, "health": 1, "singleflightFollowers": 1 }
  },
  "cache": {
    "entries": 5000,
    "bytes": 268435456,
    "totalsUpdatedAt": "2026-11-22T00:00:00.000Z",
    "totalsSource": "search_cache_state",
    "totalsReason": null,
    "dbFileBytes": 300000000,
    "walFileBytes": 4194304,
    "dbFileSource": "fs.stat",
    "walFileSource": "fs.stat",
    "diskScope": "whole_sqlite_database"
  },
  "unavailable": []
}
```

The snapshot is bounded and read-only: it performs primary-key cache totals and
file `stat` calls, never `cache.stats()`, provider row scans, or database writes.
`dbFileBytes` and `walFileBytes` describe the **whole SQLite database**, not only
cached responses. Unknown values are `null` and include a machine-readable reason
in `unavailable`; no filesystem path or raw error message is returned. A cache totals row with a malformed
`updatedAt` is treated as unavailable for this read-only endpoint (`totals_missing`/`invalid_value`) and is not repaired by the GET.

## Search

```http
POST /api/search
POST /api/search/deep
GET  /api/search/tasks/:id
POST /api/search/tasks/:id/cancel
```

Request body:

```json
{
  "query": "self-hosted search aggregation",
  "providers": ["prv_abc", "prv_def"],
  "group": "news",
  "limit": 20,
  "perProviderLimit": 10,
  "language": "zh-CN",
  "freshness": "week",
  "mode": "rrf",
  "rerank": false,
  "summarize": false,
  "timeoutMs": 15000,
  "rerankModelId": "mdl_x",
  "chatModelId": "mdl_y"
}
```

`providers` and `group` are mutually exclusive; `group` wins. Omit both to use every enabled provider.

`GET /api/providers` requires `sources:read` and returns provider summaries plus
runtime snapshots. Each summary includes `keyCount`, `healthyKeyCount` and
`availableKeyCount`; the latter is the scheduler's current usable-key count and
never contains key material.

Modes: `basic` (rank by provider order), `rrf` (fusion), `rerank`, `embedding`, `embedding_rerank`, `rerank_summary`, `deep` (query rewrite + multi-query + summary). Requested stages fail fast with `400` if the required model is not configured.

Response (abridged):

```json
{
  "taskId": "task_...",
  "status": "completed | partial | failed",
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "snippet": "...",
      "source": "brave-eu · searxng-cn",
      "provider": "prv_abc",
      "providerType": "brave",
      "providerName": "brave-eu",
      "publishedAt": "2026-05-01T00:00:00.000Z",
      "retrievedAt": "2026-11-13T04:00:00.000Z",
      "score": 1,
      "fusionScore": 0.0328,
      "sources": [{ "providerId": "prv_abc", "providerName": "brave-eu", "rank": 1, "url": "..." }]
    }
  ],
  "stats": {
    "rawCount": 12,
    "dedupedCount": 4,
    "fusedCount": 4,
    "providers": [{ "providerId": "...", "ok": true, "latencyMs": 57, "resultCount": 6, "attempts": 1 }],
    "timing": { "totalMs": 60, "fanoutMs": 57, "fusionMs": 2 },
    "partial": false,
    "cached": false
  },
  "errors": [],
  "failedSources": [],
  "summary": { "text": "... [1]", "citations": [{ "index": 1, "title": "...", "url": "..." }] }
}
```

Behaviour:

- `status: "partial"` — at least one provider failed; healthy results are returned.
- `status: "failed"` — no provider succeeded; HTTP status is `503`, results is empty, `failedSources` lists the codes.
- `failedSources` is a compact, stable view: `[{ "id": "prv_...", "code": "rate_limited" }]`.
- `stats.cached: true` — served from the in-process cache (only when enabled in Settings).
- Cancellation: aborting the HTTP request aborts provider calls. `POST /api/search/tasks/:id/cancel` works for a task whose id is already known (for example from an async client).

`/api/search/deep` accepts the same body; `mode` is forced to `deep`.

## Providers

```http
GET /api/providers              # scope sources:read
```

```json
{
  "providers": [{ "id": "prv_...", "name": "brave-eu", "type": "brave", "enabled": true, "keyCount": 2, "healthyKeyCount": 2, "circuitOpen": false }],
  "status": [{ "providerId": "prv_...", "healthy": true, "keys": [{ "id": "key_...", "status": "healthy", "inFlight": 0, "rpmUsed": 3 }] }],
  "catalog": [{ "type": "brave", "implementation": "builtin", "verification": "documented" }],
  "adapters": ["brave", "searxng", "generic-http", "mock"]
}
```

No key material is ever included.

## Admin API

All routes below require an admin session **and** the CSRF header.

### Providers and keys

```http
GET    /api/admin/providers
POST   /api/admin/providers
PATCH  /api/admin/providers/:id
DELETE /api/admin/providers/:id
POST   /api/admin/providers/:id/test          {keyId?}
GET    /api/admin/providers/:id/status
GET    /api/admin/providers/:id/keys
POST   /api/admin/providers/:id/keys          {label,key,weight,enabled}
PATCH  /api/admin/keys/:keyId                 {label?,key?,weight?,enabled?}
DELETE /api/admin/keys/:keyId
POST   /api/admin/keys/:keyId/test
POST   /api/admin/providers/validate-generic  {config}
GET    /api/admin/groups
POST   /api/admin/groups
PATCH  /api/admin/groups/:id
DELETE /api/admin/groups/:id
```

Creating a provider whose `catalog.implementation` is `planned` or `unavailable` returns `501` with the catalog reason. Key create and Key update require `key` to contain at least 8 characters after trimming (maximum 8192); a shorter value is `400 validation_error`. Key summaries include redacted `lastErrorCode` / `lastErrorMessage`; a successful test clears them. No secret, ciphertext, IV or auth tag is returned.

### Models

```http
GET    /api/admin/models
POST   /api/admin/models
PATCH  /api/admin/models/:id
DELETE /api/admin/models/:id
POST   /api/admin/models/:id/test
```

Embedding models require `dimensions`. `POST /:id/test` performs a real network call; a wrong key must fail.

A model `baseUrl` that the current SSRF policy can never reach is rejected with `403 blocked` at create/update time — an IP literal or `localhost`-style hostname that is private/reserved and not on `settings.security.privateHostAllowlist`, or a cloud metadata address (never allowed). Hostnames are still resolved and validated on every request, so a later DNS change to a private address is blocked at call time. See `docs/model-integration-status.md` for what each vendor/kind pair actually implements.

### System

```http
GET  /api/admin/dashboard?range=1h|24h|7d|30d
GET  /api/admin/settings
PUT  /api/admin/settings
GET  /api/admin/tokens
POST /api/admin/tokens            {name,scopes,rateLimitPerMin,expiresAt?}
DELETE /api/admin/tokens/:id
GET  /api/admin/logs?limit=&offset=&providerId=
GET  /api/admin/audit?limit=
GET  /api/admin/skills
GET  /api/admin/config/export
POST /api/admin/config/import     {config}
GET  /api/admin/cache
POST /api/admin/cache/sweep
POST /api/admin/cache/clear       {confirm:true}
GET  /api/mcp/info
```

Config export contains provider/model/group configuration plus **key labels only**; imported keys must be re-entered.

### Provider health

```http
GET  /api/admin/provider-health
GET  /api/admin/provider-health/settings
PUT  /api/admin/provider-health/settings   {scheduledEnabled?,intervalMinutes?,maxRequestsPerRun?,maxRequestsPerDay?,anonymousMaxRequestsPerRun?,anonymousMaxRequestsPerDay?,connectMaxRequestsPerProbe?,connectMaxRequestsPerDay?,paidProbesEnabled?,concurrency?}
GET  /api/admin/provider-health/history?providerId=&limit=
POST /api/admin/provider-health/:id/probe  {kind:"connect"|"search"}
POST /api/admin/provider-health/:id/auto-probe  {enabled:boolean}
POST /api/admin/provider-health/:id/reset
GET  /api/admin/provider-health/batch-test/preview?kind=&providerIds=&includeKeyless=
POST /api/admin/provider-health/batch-test         {kind?,providerIds?,includeKeyless?,concurrency?}
GET  /api/admin/provider-health/batch-test/:jobId
POST /api/admin/provider-health/batch-test/:jobId/cancel
```

```jsonc
// GET /api/admin/provider-health — one provider entry
{
  "providerId": "prv_…", "providerName": "Brave", "providerType": "brave",
  "runtime": "healthy",                        // operator-facing state
  "implementation": {                          // how the adapter was validated
    "verification": "documented",              // never upgraded by a probe
    "implementation": "builtin", "docsUrl": "…"
  },
  "status": "healthy",                         // stored four-value column
  "autoProbeEnabled": true, "nextProbeAt": "2026-11-17T14:00:00.000Z",
  "probeMode": "connect", "keyAvailable": 2, "keyTotal": 3
}

// budget block (UTC day boundary, all three counters explicit)
{
  "day": "2026-11-21", "maxPerRun": 3, "maxPerDay": 20,
  "usedToday": 4, "connectUsedToday": 11, "anonymousSearchUsedToday": 6,
  "anonymousMaxPerRun": 3, "anonymousMaxPerDay": 20, "anonymousRemainingToday": 14,
  "connectMaxPerProbe": 5, "connectMaxPerDay": 50, "connectRemainingToday": 39,
  "remainingToday": 16,
  "paidProbesEnabled": false, "scheduledEnabled": true, "intervalMinutes": 360
}
```

- `kind:"search"` may cost money. When paid probing is disabled or the paid/anonymous ledger is full the API returns `400 validation_error` (paid disabled) or `429 quota_exceeded` (budget) and records no health conclusion.
- `kind:"connect"` uses an independent physical-hop budget. `connectMaxRequestsPerProbe` (default 5, range 1–20) and `connectMaxRequestsPerDay` (default 50, range 1–2000) are reserved at the fetch boundary for every page and redirect. A local refusal is `429 quota_exceeded` with `details.localBudget=true`; it does not write a health/billing row, invalidate the Key or park the provider.
- A credentialed `generic-http` source does not support `kind:"connect"`; the request is rejected before upstream work. An anonymous `generic-http` connect probe executes a search and is charged to `search_anonymous`.
- All probe paths share one per-provider in-flight lock. A duplicate single/Key/scheduled probe returns `409 already_running`; a bulk runner records `code:"already_running"`, `state:"skipped"`, `checkId:null` and sends no second request.
- `maxRequestsPerRun` / `maxRequestsPerDay` / `anonymousMaxRequestsPerRun` /
  `anonymousMaxRequestsPerDay` / `connectMaxRequestsPerProbe` /
  `connectMaxRequestsPerDay` / `intervalMinutes` / `concurrency` are bounded
  server-side; a value outside the range is `400`, not clamped.
- `usedToday` counts searches made **with a credential** (the paid bucket).
  `anonymousSearchUsedToday` counts real searches against keyless sources: they
  are exempt from the paid switch, use `anonymousMaxPerRun/Day`, and are counted
  rather than labelled free. Optional key pools do not make a keyless provider paid.
- A cancelled probe records no health conclusion. If `requests` is `null`/`0`,
  the reservation is released on its original `budget_day` and the billing row is
  written with `spent=false`; if any physical request was attempted, the slot is
  kept even when the probe was cancelled or failed.
- `provider_health_billing` stores the exact bucket, reservation day,
  classification, credential-use fact and `spent`. Probe results and
  `detail_json` include `billingUnit:"unknown"`: HTTP hops are a local safety
  metric, never a vendor billing claim. Restart seeding and the 0009 one-shot
  recompute count only `spent=true` rows; legacy anonymous history is accepted
  only when its classification is exact.
- Migration `0010` archives the old `connect` ledger rows and recomputes usage
  from spent billing rows joined to `detail_json.requests`. Missing/zero/invalid
  counts conservatively count as one hop; `max(current,recomputed)` prevents a
  decrease, and replaying the migration is idempotent.
- Migration `0011` marks new diagnostics as sanitized. Pre-upgrade free-form
  diagnostics remain unchanged in SQLite but read as
  `[redacted: legacy diagnostic]`, including after Key rotation or deletion.
- Every health GET surface is read-only. Batch preview, overview, settings and
  MCP health do not insert health, billing, budget, job or audit rows. A missing
  ledger row is computed from spent billing rows without materializing it.
- `reset` writes a marker; probes older than it stop deciding the status. History
  is kept and credentials are untouched.

### Single-source test (v0.1.10)

```http
POST /api/admin/providers/:id/test   {kind?,keyId?,trigger?}
POST /api/admin/keys/:keyId/test     # always kind:"connect"; still consumes connect hops
```

```jsonc
{
  "ok": true, "latencyMs": 412, "resultCount": 3,
  "message": "3 result(s) in 412ms",
  "sample": [{ "title": "…", "url": "…" }],
  // additive — the five fields above keep their names and types
  "status": "healthy",           // stored four-value status
  "cause": "ok",                 // classification (`empty_results`, `auth_invalid`, …)
  "errorCode": null,             // provider-error vocabulary, or null
  "requests": 2,                 // physical upstream requests; null = none sent
  "billingUnit": "unknown",      // hops are not a vendor billing unit
  "spent": true,                 // paid-search budget slot consumed; connect hops use their own bucket
  "kind": "search",
  "keyId": "key_…",              // identifier only, never the secret
  "checkedAt": "2026-11-19T…Z"
}
```

- `ok` is `cause === "ok"` and nothing else: an HTTP 200 with zero results is
  `empty_results`, which is "answered, but nothing came back".
- `:id/test` defaults to `kind:"search"` and therefore obeys the paid-probe
  switch: paid probing disabled → `400 validation_error`, budget exhausted →
  `429 quota_exceeded`. `/keys/:keyId/test` stays `kind:"connect"`: it does not
  consume a paid-search slot, but every physical hop consumes the connect budget
  and the vendor billing unit remains unknown.
- `requests` is counted at the fetch boundary (every physical request, redirects
  and pages included). `null` means no request was sent; it is never derived from
  the planned page count.
- An explicit `keyId` must belong to the provider in the path. A cross-provider id
  is rejected before health, budget or upstream work.
- No key material appears in the response: `keyId` is an identifier and `sample`
  holds only title/url. Optional key pools on keyless providers are not used
  automatically; only `providerRequiresKey` or an explicit `keyId` takes a lease.
- Error messages and `details.url` redact credential-bearing query parameters,
  including percent-encoded names/values and custom generic-http query
  injections. Non-sensitive parameters (`q`, `engine`, `page`, …) remain useful
  for diagnosis. The same rule covers JSON/HTML error bodies, SQLite health
  history, Key `last_error_message`, audit detail and MCP health output.

### Bulk provider test (v0.1.10, updated v0.1.12)

```jsonc
// GET /api/admin/provider-health/batch-test/preview?kind=search&includeKeyless=true
{
  "kind": "search", "total": 20,
  "counts": { "eligible": 12, "noKey": 3, "noEnabledKey": 2, "configError": 0,
              "disabled": 3, "keylessSkipped": 0, "coolingSkipped": 0 },
  "budget": { "paidProbesEnabled": true, "remainingToday": 8, "remainingRun": 10,
              "anonymousRemainingToday": 14, "anonymousMaxPerRun": 3,
              "maxPerDay": 100, "maxPerRun": 10, "day": "2026-11-20", … },
  "paidRisk": true, "estimatedPaidProbes": 12, "estimatedAnonymousProbes": 0
}
```

- The seven counters always sum to `total`; cooldown, quota, account quota and
  paid-policy skips share `coolingSkipped`. Per-item `code` distinguishes them.
- `includeKeyless` defaults to `false` and is task-scoped. `estimatedPaidProbes`
  counts potential credential-required searches; `estimatedAnonymousProbes`
  counts eligible keyless probes. `paidRisk` is true only when paid probing is on
  and at least one paid probe is potential.
- The preview is a **read**: it writes no health, billing, budget, job, settings
  or audit rows. If today's ledger row is absent, usage is derived from spent
  billing rows in memory.

```jsonc
// POST /api/admin/provider-health/batch-test  → 201
{ "jobId": "bt_…", "status": "running", "total": 20, "concurrency": 2 }
```

- `kind` defaults to `search`; `providerIds` omitted means **every configured
  source** (the same scope the preview described), `[]` is `400` ("nothing to
  test"), `includeKeyless` defaults to `false`, and `concurrency` is `1..4`.
- A paid-only search scope with paid probing disabled or its budget exhausted is
  refused before insertion with `409 validation_error`. A mixed scope skips paid
  sources (`SKIPPED_PAID_DISABLED` / `SKIPPED_BUDGET`) and continues anonymous
  sources; an anonymous-only scope is always allowed.
- A connect scope uses `connectMaxRequestsPerProbe/Day`. A local per-probe or
  daily refusal is caught by the runner as `state:"skipped"`,
  `code:"SKIPPED_BUDGET"`, `checkId:null`; it is not a failed provider and does
  not abort other eligible items.
- Every runner item acquires the same `probeWithLock` gate as a single test. If
  another path already owns that provider, the item is skipped with
  `code:"already_running"` and no second upstream request is sent.

```jsonc
// GET /api/admin/provider-health/batch-test/:jobId
{
  "jobId": "bt_…",
  "status": "running" | "completed" | "partial" | "cancelled" | "interrupted",
  "kind": "search",
  "counts": { "total": 20, "done": 7, "ok": 5, "failed": 1, "pending": 1,
              "skipped": 8, "remaining": 5 },
  "items": [
    { "providerId": "prv_…", "providerName": "Brave", "providerType": "brave",
      "state": "ok" | "failed" | "pending" | "skipped" | "unknown",
      "keyCount": 2, "checkedAt": "2026-11-19T12:03:05.000Z",
      "code": "ok" | "auth_invalid" | "SKIPPED_NO_KEY" | …, "latencyMs": 412,
      "resultCount": 3, "requests": 2, "checkId": "hc_…", "reason": null }
  ],
  "budget": { … }, "includeKeyless": true, "concurrency": 2,
  "startedAt": "…", "finishedAt": null,
  "nextPollAfterMs": 1000            // null once the run stopped
}
```

- Invariants: `done + skipped + remaining === total` and
  `ok + failed + pending === done`.
- `state: "unknown"` means "not started yet"; it is what makes a partial run
  describable as `部分完成 (done+skipped/total)` and never as "all done".
- `requests: null` renders as `—`. `checkId: null` means no health conclusion was
  written for this item (skipped, cancelled, or refused before the call).
- `providerType`, `keyCount` and `checkedAt` describe the run as it happened and
  are copied into the ledger, so a row stays readable after the source is deleted
  or re-typed. `keyCount` is a **count of credentials**, never a key or a key id.
  Rows written by an earlier build read as `null` (rendered `—`); `checkedAt` is
  `null` for anything that was never probed.
- Terminal reads always have `remaining: 0` and `nextPollAfterMs: null`. After a
  restart a run that was still going reads `interrupted`, its unknown items read
  `SKIPPED_INTERRUPTED`, and it is **never** `completed`.

```jsonc
// POST /api/admin/provider-health/batch-test/:jobId/cancel
{ "jobId": "bt_…", "status": "cancelled", "skippedRemaining": 5 }
```

- Cancel atomically rewrites unknown items, all counters, status, `finishedAt` and
  `itemsJson` in one transaction, then aborts outside it. Finished items keep their
  conclusion. Cancelling a job that already stopped is `409 conflict`; concurrent
  cancels have exactly one winner.
- All routes need `admin` scope; writes need CSRF. A `search`-scope token gets 403.

### Cache

```jsonc
// PUT /api/admin/settings — TTL in seconds, presented as 1–72 hours in the UI
{ "cache": { "enabled": true, "ttlSeconds": 86400 } }

// GET /api/admin/cache
{
  "entries": 12, "bytes": 148320, "maxEntries": 5000, "maxBytes": 268435456,
  "hits": 40, "misses": 9, "hitRate": 0.8163,
  "hits24h": 40, "misses24h": 9, "hitRate24h": 0.8163,
  "expiredRemoved": 3, "evicted": 0,
  "lastSweepAt": "2026-11-17T08:10:00.000Z",
  "enabled": true, "ttlSeconds": 86400, "windowHours": 24
}
```

- `ttlSeconds` must be 3600–259200 while `enabled` is true; 0 is only valid when
  disabled. Negative, fractional and >259200 values return `400`.
- `hitRate` is `null` until at least one lookup has been recorded — the client
  shows "no data" rather than 0%.
- `POST /api/admin/cache/clear` requires `{"confirm": true}`; without it the API
  returns `400` and nothing is deleted. The action writes an audit record.
- A search response that was served from the cache has `stats.cached: true` and
  the MCP `search_web` tool returns `cached: true` for the same reason.

## Search quality

All routes require an `admin` session; mutations also require `x-csrf-token`.
A `search`-scope bearer token receives `403`.

```jsonc
GET  /api/admin/quality/datasets?limit=&offset=  → { datasets, total, hasMore, limit, offset }
POST /api/admin/quality/datasets                 { name, description?, language? }
GET  /api/admin/quality/datasets/:id?queriesLimit=&queriesOffset=&judgmentsLimit=&judgmentsOffset=
                                                 → { dataset, queries, judgments, coverage,
                                                     queriesPage, judgmentsPage }
POST /api/admin/quality/datasets/:id/queries     { queries: [{ query, category?, extraCategories?, intent? }] }
POST /api/admin/quality/datasets/:id/judgments   { judgments: [{ queryId, url|documentId, relevance }] }
POST /api/admin/quality/datasets/:id/freeze      { judgmentsComplete? }
POST /api/admin/quality/datasets/:id/fork
GET  /api/admin/quality/datasets/:id/export      → search-hub.quality.dataset/1
POST /api/admin/quality/datasets/import
GET  /api/admin/quality/datasets/:id/unjudged?limit=&offset=&includeDocuments=
                                                 → { total, limit, offset, hasMore, queries }

GET  /api/admin/quality/runs?datasetId=&limit=&offset=  → { runs, total, hasMore }
POST /api/admin/quality/runs                     { datasetId, mode, fusion, limit?, cutoff?,
                                                   snapshotRunId?, providerIds?, requestBudget?,
                                                   confirmPaid?, queryIds?, unitCosts?,
                                                   perProviderLimit?, timeoutMs?,
                                                   cachePolicy?: "bypass", maxConcurrency?: 1 }
GET  /api/admin/quality/runs/:id                 → { run, metrics, latency, cost, quality, byCategory, perQuery }
POST /api/admin/quality/runs/:id/cancel
GET  /api/admin/quality/compare?baseline=&candidate=&metric=
POST /api/admin/quality/sweep                    { datasetId, kValues?, metric?, developmentShare? }
POST /api/admin/quality/prune                    { olderThanDays, keepLatest? }
```

### Request accounting (v0.1.9)

A run reports three separate counts, because they differ as soon as an adapter paginates:

| Field | Meaning |
|---|---|
| `cost.logicalSearches` | searches the caller asked for |
| `cost.adapterAttempts` | adapter invocations, retries included (what the key scheduler meters) |
| `cost.httpRequests` / `cost.requests` | physical HTTP requests: pages, retries and redirect hops |
| `cost.billableUnits` | always `null` — no vendor billing rule is derivable from a request count |

`requestsUsed` on the run row is the physical count. `ProviderAttemptStat.httpRequests`
carries the same number per provider. A hop refused by the outbound policy is not counted;
a request already sent is never refunded.

A metric that cannot be computed is serialised as
`{ "value": null, "status": "na", "reason": "qrels_incomplete" }` — never as `0`.
`reason` is one of `no_results`, `no_judgments`, `qrels_incomplete`,
`no_relevant_documents`, `not_applicable`.

`POST /api/admin/quality/runs` rejects with `400` when:

- the dataset is not frozen (`conflict` semantics are expressed as 400 here
  because the request cannot succeed without changing the dataset);
- `mode: "live"` is missing `confirmPaid`, `providerIds` or a positive
  `requestBudget`;
- the worst case (`queries × providers × 2`) exceeds `requestBudget`;
- an offline run has no snapshot source: no `snapshotRunId`, and the dataset is
  not a synthetic fixture.

`GET .../compare` returns `verdict: "insufficient_evidence"` with a `reason`
when there are fewer than 8 comparable queries or either side is unmeasurable.
The API does not invent a winner in that case.

## Examples

```bash
# token-authenticated search
curl -sS http://localhost:8787/api/search \
  -H "authorization: Bearer $SEARCH_HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"query":"rust async runtime","mode":"rrf","limit":5}'
```

```python
import requests

response = requests.post(
    "http://localhost:8787/api/search",
    headers={"Authorization": f"Bearer {token}"},
    json={"query": "rust async runtime", "mode": "rrf", "limit": 5},
    timeout=30,
)
response.raise_for_status()
for item in response.json()["results"]:
    print(item["title"], item["url"], item["source"])
```

```ts
const response = await fetch("http://localhost:8787/api/search", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ query: "rust async runtime", mode: "rrf", limit: 5 }),
});
if (!response.ok) throw new Error((await response.json()).error.message);
const { results } = await response.json();
```

## Optional cache and degraded models

- The response cache is **off by default** (`settings.cache.enabled=false`). When enabled, `stats.cached=true` marks a hit.
- Send `"skipCache": true` to force a live run; the search lab always sets it.
- Optional stages (rerank / embedding / summary) never fail the request. A failure sets `stats.degraded=true`, leaves the base results intact, and appends a `*-model` entry to `errors[]`.

## Backup and legacy migration

```http
POST /api/admin/maintenance/checkpoint      # wal_checkpoint(TRUNCATE)
GET  /api/admin/backup                      # consistent SQLite snapshot (no master.key)
POST /api/admin/backup/verify               # verify an uploaded .db (raw body, 64 MB cap)
POST /api/admin/migration/legacy            # {mode:"dry_run"|"apply", payload, confirm?, baseUrl?}
```

`GET /api/admin/backup` uses the SQLite Online Backup API (fallback `VACUUM INTO`) rather than a checkpoint plus file read, so concurrent searches cannot land between the copy and the response. The snapshot is normalised to `journal_mode=delete`, verified with `PRAGMA integrity_check`, and only then renamed into place; a failure returns a JSON error rather than a partial file. Response headers `x-search-hub-schema-version` / `x-search-hub-user-version` identify the schema for the restore check. `master.key` is never included.

`POST /api/admin/backup/verify` accepts the file as the raw request body (`content-type: application/octet-stream`) and returns integrity, schema version, applied migrations, tables and row counts, then deletes its temp copy:

```json
{ "ok": true, "compatible": true, "integrity": "ok", "schemaVersion": "0001_init.sql",
  "userVersion": 1, "migrations": ["0001_init.sql"], "pendingMigrations": [],
  "tables": ["admin_users", "..."], "rowCounts": { "api_keys": 3 }, "bytes": 438272 }
```

A snapshot from a **newer** release returns `{ "ok": false, "compatible": false, "reason": "backup was created by a newer version" }`, and starting this build against such a database fails at boot with an explicit "schema is newer than this build" error. See [deployment.md](./deployment.md#backup-and-restore).

The migration endpoint accepts the provider list of an older Search Hub deployment. It **never reads or stores credentials**: the plan lists which providers need a key, and you re-enter keys in the UI. `apply` requires `"confirm":"IMPORT LEGACY PROVIDERS"` and skips names that already exist (no overwrite). See [legacy-migration.md](./legacy-migration.md).

## Rate limits

- Global: 300 requests/minute per IP (`/api/health` exempt).
- Login: `settings.security.loginRateLimitPerMin` per IP.
- Tokens: `rateLimitPerMin` per token, enforced in-process.

Rate limiting is per process; replica-level coordination is not implemented.

### Provenance and paging (v0.1.10)

`GET /runs/:id` returns these fields on `run` in addition to the pre-v0.1.10 set:

| Field | Meaning |
|---|---|
| `providerIds` | sources that actually took part; `[]` when not recorded |
| `providerFingerprint` | sha256 (32 hex) over credential-free source settings |
| `qrelsFingerprint` | sha256 over the qrel set, including its completeness flag |
| `modelFingerprint` | `null` means **no model took part** — a fact, not a gap |
| `provenanceComplete` | false when any of the three above is absent |
| `provenanceMissing` | which of them is absent, so the gap is nameable |
| `perProviderLimit` / `timeoutMs` | what the run actually used; `null` on older runs |
| `partial` / `persistedQueryCount` | how much of the run was written before it stopped |
| `failureReason` | `persistence_failed` · `cancelled` · `internal_error` |

`GET /datasets/:id` keeps `queries`, `judgments` and `coverage` at their original
meaning with one change: when a dataset holds more than 200 queries or judgments,
those arrays hold the first page and `queriesPage` / `judgmentsPage` carry
`{ total, offset, limit, hasMore }`. **`coverage` is always computed over the whole
dataset**, so it does not move when a reader pages.

`GET /compare` adds `byCategory` (groups overlap when a query carries two labels)
and `movements` (document-level rank changes; `entered` / `exited` rows carry
`deltaPositions: null`, never 0).

### Errors added by v0.1.10

| Case | Status | Code |
|---|---|---|
| `cachePolicy` other than `bypass`, `maxConcurrency` above 1 | 400 | `validation_error` + `details.unsupportedOption` |
| duplicate or >3 category labels | 400 | `validation_error` + `details.queries[i]` |
| unsafe import key / depth / URL scheme | 400 | `validation_error` + `details.path` |
| body over the limit | 413 | `bad_request` |
| result write failed, volume full | **507** | `internal_error` (+ `details.runId`) |
| result write failed, other cause | 500 | `internal_error` (+ `details.runId`) |

### Contracts added by v0.1.12

| Case | Status | Code / result |
|---|---|---|
| another probe owns the same provider | 409 | `already_running` |
| connect per-probe or UTC-day hop cap reached locally | 429 | `quota_exceeded` (+ `details.localBudget`) |
| Key create/update shorter than 8 trimmed characters | 400 | `validation_error` |
| bulk item loses the shared in-flight lock | item result | `state:"skipped"`, `code:"already_running"`, `checkId:null` |
| bulk connect item hits a local hop cap | item result | `state:"skipped"`, `code:"SKIPPED_BUDGET"`, `checkId:null` |
| health preview/overview/settings/MCP read | 200 | no database writes |
