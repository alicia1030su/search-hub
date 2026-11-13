# Provider guide

A provider is a plugin that turns the Search Hub query into a vendor request and maps the response into a shared result shape. The core never switches on vendor names.

## Current coverage

| Type | Implementation | Requires key | Verification |
|---|---|---|---|
| `brave` | Built-in | Yes | Documented; **not live-tested** (no subscription key) |
| `searxng` | Built-in | Optional | Documented; **not live-tested** (no instance) |
| `generic-http` | Built-in, declarative | Optional | Tested against local mock servers |
| `mock` | Built-in, deterministic | No | Used by the test suite |

Catalog-only entries (13 planned, 2 without an official API, 7 generic gateway presets) cannot be created. See `packages/providers/src/catalog.ts` for the exact reason on each.

## Contract

```ts
interface SearchProviderAdapter {
  readonly type: string;
  readonly requiresKey: boolean;
  readonly supportsTest: boolean;
  search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput>;
  test?(ctx: ProviderContext): Promise<ProviderTestResult>;
}
```

- `ProviderContext.fetch` is the SSRF-safe fetch. Never use global `fetch` directly.
- `ctx.apiKey` is decrypted for this call only; do not cache or log it.
- `ctx.signal` carries the per-provider timeout and the global deadline.
- Return `RawSearchResult[]` with `title`, `url`, and optional `snippet`, `publishedAt`, `score`, `language`.

### Error mapping

| Upstream | Code | Scheduler reaction |
|---|---|---|
| `401`, `403` | `auth_invalid` | Key suspended until re-tested |
| `429` | `rate_limited` | Cooldown using `Retry-After` (or provider default) |
| `402` | `quota_exceeded` | Cooldown until next UTC day / retry-after |
| `408`, `504`, network | `timeout` / `network` | Retry with backoff, then cooldown |
| `5xx` | `server_error` | Retry with backoff, then circuit breaker |
| `400`, `422` | `bad_request` | No retry; surfaces the vendor message |
| SSRF block | `blocked` | No retry |

Never map a failure to an empty success. A provider that returns zero results must return `{ results: [] }`; a provider that failed must throw.

## Brave

- `GET {baseUrl}/res/v1/web/search`
- Headers: `X-Subscription-Token: <key>`, `Accept: application/json`
- Query: `q`, `count` (≤20), `offset`, `search_lang`, `freshness` (`pd`/`pw`/`pm`/`py`), optional `country`
- Response: `web.results[]` with `title`, `url`, `description`, `page_age`
- Default base URL: `https://api.search.brave.com`

## SearXNG

- `GET {baseUrl}/search?q=...&format=json`
- The instance must enable JSON output (`search.formats: [json]`); otherwise it returns `403`, which the adapter reports with a fix hint.
- Optional `Authorization: Bearer` is forwarded for instances behind an authenticating proxy.
- Response: `results[]` with `title`, `url`, `content`, `publishedDate`, `score`

## Generic HTTP/JSON

The declarative adapter has no arbitrary code execution. Configuration:

```json
{
  "method": "POST",
  "path": "/v1/search",
  "headers": { "X-Client": "search-hub" },
  "query": { "q": "{{query}}", "count": "{{limit}}" },
  "body": { "query": "{{query}}", "lang": "{{language}}" },
  "keyInjection": { "in": "header", "name": "X-API-Key", "prefix": "" },
  "resultsPath": "data.items",
  "mapping": {
    "title": "name",
    "url": "link",
    "snippet": "summary",
    "publishedAt": "published_at",
    "score": "relevance"
  }
}
```

Template variables: `{{query}}`, `{{key}}`, `{{limit}}`, `{{language}}`, `{{freshness}}`, `{{page}}`.

Rules:

- Paths must match `a.b[0].c`; `..`, semicolons, and spaces are rejected.
- `resultsPath` must resolve to an array; otherwise the call fails with a clear message.
- `keyInjection.in` is `header`, `query`, or `body`; body uses a dotted path.
- Use **Validate config** in the UI (or `POST /api/admin/providers/validate-generic`) before saving.

## Mock

Deterministic test provider:

```json
{ "resultCount": 6, "latencyMs": 40, "failMode": "none", "namespace": "a", "sharedUrl": true }
```

`failMode`: `none`, `empty`, `server_error`, `rate_limited`, `auth_invalid`, `timeout`. `sharedUrl: true` adds a URL shared across instances so de-duplication and source merging are testable. It is labelled as a test source in the catalog and must not be presented as real search coverage.

## Adding a provider

1. Research the official API (URL, auth, request, response, limits, error semantics). If it cannot be verified, add a catalog entry only.
2. Implement the adapter with `callJson` from `packages/providers/src/http.ts`.
3. Map errors as above; include `Retry-After` when present.
4. Register it in `registry.ts`.
5. Add tests: happy path, 401, 429 with `Retry-After`, 5xx, malformed payload, missing key.
6. Update the catalog with `verification: "documented"`, and only use `live_tested` with recorded evidence.
7. Update README tables and this document.

PRs without negative-path tests or with a fabricated "supported" claim will be rejected.

## Provider instance settings

| Field | Meaning |
|---|---|
| `name` / `type` | Display name / adapter type |
| `enabled` | Included in searches |
| `baseUrl` | Override the default endpoint |
| `timeoutMs` | Per-call timeout (bounded by the global deadline) |
| `maxConcurrency` | Per-key concurrent requests |
| `priority` / `weight` | Ordering and weighted-random selection |
| `maxRetries` | Retries per call (also bounded by a request-level budget) |
| `language` / `freshness` | Defaults for this instance |
| `resultsPerPage` | Requested result count |
| `rpmLimit` / `dailyQuota` | Per-key limits |
| `keyStrategy` | `round_robin` / `random` / `weighted_random` / `least_used` / `failover` |
| `cooldownMs` | Base cooldown after 429/5xx |
| `breakerThreshold` / `breakerCooldownMs` | Provider circuit breaker |
| `config` | Adapter-specific JSON (mapping, mock behaviour) |
