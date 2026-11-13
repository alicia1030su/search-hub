# Provider guide

A provider is a plugin that turns the Search Hub query into a vendor request and maps the response into a shared result shape. The core never switches on vendor names.

## Current coverage

| Type | Implementation | Requires key | Verification |
|---|---|---|---|
| `tavily` | Built-in | Yes | Documented; **not live-tested** (no API key) |
| `bocha` | Built-in | Yes | Documented; **not live-tested** (no API key) |
| `brave` | Built-in | Yes | Documented; **not live-tested** (no subscription key, and `api.search.brave.com` is unreachable from the dev network) |
| `searxng` | Built-in | Optional | Documented; **not live-tested** (no instance) |
| `hackernews` | Built-in | No | `live_tested` (v0.1.1), technical-community search only |
| `generic-http` | Built-in, declarative | Optional | Tested against local mock servers |
| `mock` | Built-in, deterministic | No | Used by the test suite |

Contract tests for `tavily`, `bocha`, `brave` and `searxng` live in `tests/unit/providers-web-search.test.ts`; they mock the vendor wire format locally and therefore prove protocol correctness, **not** account validity. Only `tests/scripts/provider-live.mjs` can produce live evidence. See `docs/provider-matrix.md` for the full matrix and what each provider still needs.

Catalog-only entries (12 planned, 2 without an official API, 7 generic gateway presets) cannot be created. See `packages/providers/src/catalog.ts` for the exact reason on each.

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
| SSRF block | `blocked` | No retry — and **never** `auth_invalid`: a refused destination says nothing about the key |

Vendors that repurpose standard statuses pass a `statusOverrides` table to `callJson`, so Tavily `432/433/434` and Bocha `403` keep their real meaning instead of suspending a healthy key.

Local (pre-flight) rejections from `safe-fetch` keep their own code: `blocked` for SSRF, `bad_request` for schema/cap violations, `cancelled` for aborts. They are classified **before** any HTTP-status mapping — otherwise `blocked` (which carries HTTP 403 internally) would masquerade as `auth_invalid`.

Never map a failure to an empty success. A provider that returns zero results must return `{ results: [] }`; a provider that failed must throw.

### Base URL overrides

Every key-based adapter accepts a `baseUrl` override, and the API path is **appended** to it (`joinApiPath` in `http.ts`) rather than resolved as an absolute path. `new URL("/v1/search", "https://gw.example/vendor")` would silently drop `/vendor`; appending keeps a path-mounted reverse proxy working:

| `baseUrl` configured | Tavily request | Bocha request | Brave request |
|---|---|---|---|
| `https://api.tavily.com` | `POST https://api.tavily.com/search` | — | — |
| `https://gw.example/tavily` | `POST https://gw.example/tavily/search` | — | — |
| `https://gw.example/bocha` | — | `POST https://gw.example/bocha/v1/web-search` | — |
| `https://gw.example/brave` | — | — | `GET https://gw.example/brave/res/v1/web/search` |

## Tavily

Official docs: <https://docs.tavily.com/documentation/api-reference/endpoint/search>

- `POST {baseUrl}/search` (default base URL `https://api.tavily.com`), JSON body
- Auth: `Authorization: Bearer <key>`. The vendor also accepts `api_key` in the body; this adapter deliberately uses the header so the secret never appears in request bodies, proxy logs or captured fixtures.
- `include_answer` and `include_raw_content` are pinned to `false`: this is a search source, and an LLM answer / full page text inside `results[]` would pollute fusion.

| Internal input | Request field | Notes |
|---|---|---|
| `query` | `query` | required |
| `limit` | `max_results` | clamped to the documented 1–20 range |
| config `searchDepth` | `search_depth` | `basic` (default) / `advanced` / `fast` / `ultra-fast`; unknown values fall back to `basic` |
| config `topic` | `topic` | `general` (default) / `news` / `finance` |
| `freshness` | `time_range` | `day`→`day`, `week`→`week`, `month`→`month`, `year`→`year`; `all` → omitted |
| `language` / instance `language` | `language` | **documented field** (ISO 639-1 code `en`/`zh-cn` or an English language name). `filter_by_language` stays `false`, so it is a ranking hint, never a filter |
| config `includeDomains` | `include_domains` | lower-cased, max 300 |
| config `excludeDomains` | `exclude_domains` | lower-cased, max 150 |
| — | `include_answer`, `include_raw_content` | always `false` |
| — | `include_published_date`, `filter_by_published_date` | not sent (beta); `published_date` only appears when `topic=news` |

`days` is **not** sent: the current official request schema no longer lists it (it was replaced by `time_range`), and posting an undocumented field risks a `422`.

| Response field | `RawSearchResult` |
|---|---|
| `results[].title` | `title` |
| `results[].url` | `url` |
| `results[].content` | `snippet` (HTML-stripped) |
| `results[].score` | `score` |
| `results[].published_date` | `publishedAt` |

`published_date` is only present when the vendor includes it (`topic=news` enables it; `include_published_date` is beta and stays off), so `publishedAt` is optional.

| Upstream | Code |
|---|---|
| `401`, `403` | `auth_invalid` (no retry) |
| `429` | `rate_limited` + `retryAfterMs` from `Retry-After` |
| `432` (plan/quota ceiling) | `quota_exceeded` (no retry) — vendor-specific, not a bad key |
| `433` (pay-as-you-go cap), `434` (flex-tier capacity) | `rate_limited` (retryable) |
| `5xx` | `server_error` (retryable) |
| other `4xx` | `bad_request` (no retry) |
| `200` with a malformed body / non-array `results` | `bad_request` |

Live probe (2026-11-13, invalid key): `POST /search` answered `401 {"detail":{"error":"Unauthorized: missing or invalid API key."}}` — the nested message is surfaced verbatim. Verification: `documented`. No real API key existed in this repository; run `tests/scripts/provider-live.mjs --provider tavily` before claiming `live_tested`.

## Bocha

Official docs: <https://bocha-ai.feishu.cn/wiki/RXEOw02rFiwzGSkd9mUcqoeAnNK>

- `POST {baseUrl}/v1/web-search` (default base URL `https://api.bochaai.com`; `https://api.bocha.cn` is the alias some documents use — override `baseUrl` if your account is provisioned there), JSON body
- Auth: `Authorization: Bearer <key>`

| Internal input | Request field | Notes |
|---|---|---|
| `query` | `query` | required |
| `freshness` | `freshness` | `day`→`oneDay`, `week`→`oneWeek`, `month`→`oneMonth`, `year`→`oneYear`, `all`→`noLimit` |
| `limit` | `count` | clamped to the documented 1–50 range |
| config `summary` | `summary` | **defaults to `true`**: some results come back with an empty `snippet`, and Bocha's `summary` is the page's own summary text, not an LLM answer. Set `{ "summary": false }` for the smaller payload |
| — | `page` | fixed to `1`; paging is not part of the shared input |
| `language` | — | **ignored**: Bocha has no language request parameter |

The `include` / `exclude` domain filters exist upstream but are not exposed as adapter inputs yet.

| Response field | `RawSearchResult` |
|---|---|
| `data.webPages.value[].name` | `title` |
| `data.webPages.value[].url` | `url` |
| `data.webPages.value[].snippet` (fallback `summary`, truncated) | `snippet` |
| `data.webPages.value[].datePublished` (fallback `dateLastCrawled`) | `publishedAt` |
| `data.webPages.value[].language` | `language` |

Errors arrive on two layers, so both are checked:

| Upstream | Code |
|---|---|
| HTTP `401`, envelope `code: 401` | `auth_invalid` (no retry) |
| HTTP `403`, envelope `code: 403` | `quota_exceeded` — Bocha documents 403 as **余额不足**, so the key is healthy and must not be suspended |
| HTTP `429`, envelope `code: 429` | `rate_limited` + `retryAfterMs` (from `Retry-After`, including on a 200 envelope) |
| HTTP or envelope `5xx` | `server_error` (retryable) |
| envelope `code: 400` | `bad_request` |
| HTTP 200 without `data.webPages` | **zero results**, not an error |
| HTTP 200 with non-array `data.webPages.value` | `bad_request` |

Live probe (2026-11-13, invalid key): `POST https://api.bochaai.com/v1/web-search` answered `401 {"log_id":"...","message":"Invalid API KEY","code":"401"}` — the endpoint is online and `Authorization: Bearer` is the right scheme. Verification: `documented`. Run `tests/scripts/provider-live.mjs --provider bocha` with a funded key before claiming `live_tested`.

## Brave

- `GET {baseUrl}/res/v1/web/search`
- Headers: `X-Subscription-Token: <key>`, `Accept: application/json` (Brave does **not** use `Authorization`)
- Query: `q`, `count` (1–20), `offset` (0–9), `search_lang`, `freshness` (`pd`/`pw`/`pm`/`py`), optional `country`, optional `extra_snippets=true`
- `search_lang` uses Brave's own codes, so the adapter normalizes: `zh-CN`→`zh-hans`, `zh-TW`/`zh-HK`→`zh-hant`, `ja`→`jp`, other tags lose their region
- `extra_snippets` is plan-gated upstream; enable it with provider config `{ "extraSnippets": true }`. The first extra excerpt is used as a snippet fallback when `description` is missing
- Response: `web.results[]` with `title`, `url`, `description`, `page_age`, `language`, optional `extra_snippets[]`; HTML highlight tags are stripped
- Default base URL: `https://api.search.brave.com`
- Verification: `documented`. `api.search.brave.com` timed out from the development network and no subscription token exists, so the adapter has never run live.

## SearXNG

- `GET {baseUrl}/search?q=...&format=json`
- The instance must enable JSON output (`search.formats: [json]`); otherwise it returns `403`, which the adapter reports with a fix hint.
- Optional `Authorization: Bearer` is forwarded for instances behind an authenticating proxy.
- `language` is normalized to SearXNG's codes (`zh-CN`, `zh-TW`, …), lower-case BCP-47 tags included.
- `time_range` supports only `day`, `month`, `year` upstream. The adapter widens `week` to `month` on purpose (a month window is a superset of a week, so nothing is dropped — only older pages may appear); `all` sends no `time_range`. There is no exact one-week bucket.
- Response: `results[]` with `title`, `url`, `content`, `publishedDate`, `score`
- Verification: `documented`; no SearXNG instance was available in this repository.

## Hacker News (Algolia)

- `GET {baseUrl}/api/v1/search?query=...&tags=story&hitsPerPage=N`
- Keyless, official hosted API: <https://hn.algolia.com/api>
- Optional `numericFilters=created_at_i>...` when a freshness range is set
- Response: `hits[]` with `title`, `url`, `story_text`/`comment_text`, `created_at`, `points`
- Default base URL: `https://hn.algolia.com`
- **Live verification**: v0.1.1 queried the real API through REST and MCP and got real URLs, titles, and timestamps. It is a technical-community search, not a general web index; the catalog says so explicitly.

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
5. Add contract tests to `tests/unit/providers-web-search.test.ts`: happy path, request shape, 401/403, 429 with `Retry-After`, 5xx, malformed payload, missing key, parameter mapping table.
6. Update the catalog with `verification: "documented"`, and only use `live_tested` with recorded evidence from `tests/scripts/provider-live.mjs` (a missing key prints `SKIPPED` and exits 2 — that is **not** evidence).
7. Update README tables, this document and `docs/provider-matrix.md`.

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
