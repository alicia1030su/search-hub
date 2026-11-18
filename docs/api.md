# REST API

Base URL: `https://<your-instance>`. All requests and responses are JSON.
OpenAPI 3.1: [`/api/openapi.json`](../apps/api/src/routes/openapi-routes.ts) · human-readable list: `/api/docs`.

## Authentication

Two mechanisms:

| Client | Mechanism | Notes |
|---|---|---|
| Admin UI | `sh_session` HttpOnly cookie + `x-csrf-token` header | Required on cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` |
| Integrations | `Authorization: Bearer sh_...` | Scopes: `search`, `sources:read`, `mcp:use`, `admin`. Bearer requests are not CSRF-checked because no ambient cookie is used. |

A cookie-authenticated mutation without `x-csrf-token` returns `403`, never a silent success. Bearer-token requests do not need CSRF. Tokens are shown once at creation; only their SHA-256 hash is stored.

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
| 409 | `conflict` / `already_initialized` | Duplicate name, or setup already completed |
| 429 | `rate_limited` | Login or token rate limit |
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

Creating a provider whose `catalog.implementation` is `planned` or `unavailable` returns `501` with the catalog reason.

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
PUT  /api/admin/provider-health/settings   {scheduledEnabled?,intervalMinutes?,maxRequestsPerRun?,maxRequestsPerDay?,paidProbesEnabled?,concurrency?}
GET  /api/admin/provider-health/history?providerId=&limit=
POST /api/admin/provider-health/:id/probe  {kind:"connect"|"search"}
POST /api/admin/provider-health/:id/auto-probe  {enabled:boolean}
POST /api/admin/provider-health/:id/reset
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

// budget block (UTC day boundary, both counters explicit)
{
  "day": "2026-11-17", "maxPerRun": 3, "maxPerDay": 20,
  "usedToday": 4, "connectUsedToday": 11, "anonymousSearchUsedToday": 6,
  "remainingToday": 16,
  "paidProbesEnabled": false, "scheduledEnabled": true, "intervalMinutes": 360
}
```

- `kind:"search"` may cost money. When paid probing is disabled or the ledger is
  full the API returns `400` (disabled) or `429` (budget) and records nothing.
- `maxRequestsPerRun` / `maxRequestsPerDay` / `intervalMinutes` / `concurrency`
  are bounded server-side; a value outside the range is `400`, not clamped.
- `usedToday` counts searches made **with a credential** (the paid bucket).
  `anonymousSearchUsedToday` counts real searches against keyless sources: they
  are exempt from the paid switch because no credential can spend account quota,
  and they are counted rather than labelled free.
- A cancelled probe records nothing and keeps its reservation: a cancel can
  arrive after the request left, so refunding it would let an abort loop spend
  without the ledger noticing.
- `reset` writes a marker; probes older than it stop deciding the status. History
  is kept and credentials are untouched.
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
GET  /api/admin/quality/datasets                 → { datasets: QualityDatasetSummary[] }
POST /api/admin/quality/datasets                 { name, description?, language? }
GET  /api/admin/quality/datasets/:id             → { dataset, queries, judgments, coverage }
POST /api/admin/quality/datasets/:id/queries     { queries: [{ query, category?, intent? }] }
POST /api/admin/quality/datasets/:id/judgments   { judgments: [{ queryId, url|documentId, relevance }] }
POST /api/admin/quality/datasets/:id/freeze      { judgmentsComplete? }
POST /api/admin/quality/datasets/:id/fork
GET  /api/admin/quality/datasets/:id/export      → search-hub.quality.dataset/1
POST /api/admin/quality/datasets/import

GET  /api/admin/quality/runs?datasetId=&limit=   → { runs }
POST /api/admin/quality/runs                     { datasetId, mode, fusion, limit?, cutoff?,
                                                   snapshotRunId?, providerIds?, requestBudget?,
                                                   confirmPaid?, queryIds?, unitCosts? }
GET  /api/admin/quality/runs/:id                 → { run, metrics, latency, cost, quality, perQuery }
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
