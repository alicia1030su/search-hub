# REST API

Base URL: `https://<your-instance>`. All requests and responses are JSON.
OpenAPI 3.1: [`/api/openapi.json`](../apps/api/src/routes/openapi-routes.ts) · human-readable list: `/api/docs`.

## Authentication

Two mechanisms:

| Client | Mechanism | Notes |
|---|---|---|
| Admin UI | `sh_session` HttpOnly cookie + `x-csrf-token` header | Required on every `POST`/`PUT`/`PATCH`/`DELETE` |
| Integrations | `Authorization: Bearer sh_...` | Scopes: `search`, `sources:read`, `mcp:use`, `admin` |

A session request without `x-csrf-token` returns `403`, never a silent success. Tokens are shown once at creation; only their SHA-256 hash is stored.

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
| 503 | `no_available_key` / `server_error` | All keys unavailable, or every provider failed |
| 504 | `timeout` | Global deadline exceeded |

## Setup and auth

```http
GET  /api/setup/status
POST /api/setup                 {email,password,name,setupToken?}
POST /api/auth/login            {email,password}
GET  /api/auth/session
POST /api/auth/logout
GET  /api/health
```

`POST /api/setup` succeeds only when no administrator exists. Password minimum is 12 characters. If `SEARCH_HUB_SETUP_TOKEN` is set, the token is required in the body or `x-setup-token` header.

`GET /api/health` is public and returns version, uptime, setup requirement, provider counts, and encryption-key source (never the key).

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
GET  /api/mcp/info
```

Config export contains provider/model/group configuration plus **key labels only**; imported keys must be re-entered.

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

## Rate limits

- Global: 300 requests/minute per IP (`/api/health` exempt).
- Login: `settings.security.loginRateLimitPerMin` per IP.
- Tokens: `rateLimitPerMin` per token, enforced in-process.

Rate limiting is per process; replica-level coordination is not implemented.
