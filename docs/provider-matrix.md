# Provider matrix

One table for every provider type the catalog knows about: what it is, what it needs, and — the part that matters — **what evidence is still missing before it can be called `live_tested`**.

Verification levels used by `packages/providers/src/catalog.ts`:

| Level | Meaning |
|---|---|
| `live_tested` | A recorded run against the real vendor API through this repository's adapter returned real results. Only `tests/scripts/provider-live.mjs` (or the v0.1.1 HN run) can produce this. |
| `documented` | The adapter is implemented strictly from the vendor's official documentation and covered by local contract tests (`tests/unit/providers-web-search.test.ts`). The request/response shape is believed correct; the account/quota/behaviour is unverified. |
| `unverified` | No adapter; the vendor's interface has not been verified inside this project. |
| `no_official_api` | The vendor has no public general web-search API (documented reason in the catalog). |

Contract tests use local HTTP fixtures built from the documented wire format. They prove protocol fidelity, **not** that a key works.

Two documented behaviours are easy to get wrong and are covered by tests:

- **`blocked` is not `auth_invalid`.** An SSRF rejection carries HTTP 403 internally; `callJson` classifies local rejections by their application code before any status mapping, so a refused destination never suspends a key. Verified end-to-end through `/api/search` in `tests/integration/provider-blocked.test.ts`.
- **Vendor-specific statuses keep their meaning.** Bocha `403` = 余额不足 → `quota_exceeded`; Tavily `432` → `quota_exceeded`, `433`/`434` → `rate_limited`.

## Implemented providers

| Type | Category | Official docs | Auth | Default URL | Implementation | Verification | Missing for `live_tested` |
|---|---|---|---|---|---|---|---|
| `tavily` | general | <https://docs.tavily.com/documentation/api-reference/endpoint/search> | `Authorization: Bearer` | `https://api.tavily.com` (`POST /search`) | builtin | `documented` | One Tavily API key + a successful `provider-live.mjs --provider tavily` run (2 queries, https URLs). Endpoint reachability confirmed 2026-11-13 (invalid key → 401) |
| `bocha` | general | <https://bocha-ai.feishu.cn/wiki/RXEOw02rFiwzGSkd9mUcqoeAnNK> | `Authorization: Bearer` | `https://api.bochaai.com` (`POST /v1/web-search`; `api.bocha.cn` answers with the same 401 envelope — selectable via `baseUrl`, not the default) | builtin | `documented` | One Bocha API key with balance + `provider-live.mjs --provider bocha`. Both hosts confirmed 2026-11-13 (invalid key → 401; 188ms vs 461ms) |
| `brave` | general | <https://api-dashboard.search.brave.com/app/documentation/web-search> | `X-Subscription-Token` | `https://api.search.brave.com` (`GET /res/v1/web/search`) | builtin | `documented` | A subscription token **and** network reachability — `api.search.brave.com` times out from the current dev network |
| `searxng` | general | <https://docs.searxng.org/dev/search_api.html> | none (optional Bearer for proxied instances) | user-supplied instance | builtin | `documented` | A reachable self-hosted instance with `search.formats: [json]` enabled |
| `hackernews` | general (domain: HN) | <https://hn.algolia.com/api> | none | `https://hn.algolia.com` | builtin | `live_tested` (v0.1.1) | Nothing. It is a technical-community search and must not be presented as a general web index |
| `search-hub-legacy` | compat | — (calls an existing Search Hub REST API) | optional `Authorization: Bearer` | `http://127.0.0.1:44475` (`POST /api/search`, path/mode configurable) | builtin | `documented` | A real legacy instance **plus explicit authorisation to connect**; contract tests use a local fake only |
| `generic-http` | custom | — (user-supplied) | optional, declarative injection | user-supplied | builtin | `documented` | Not applicable — its correctness is the user's mapping; validated by `POST /api/admin/providers/validate-generic` and local mock tests |
| `mock` | custom | — | none | — | builtin | `live_tested` (test-only) | Nothing; it is a deterministic test source and must never be shown as real coverage |

## Catalog-only entries — planned

| Type | Category | Official docs | Auth | Missing for `live_tested` |
|---|---|---|---|---|
| `metaso` | general | — | api_key | Verified official endpoint, auth and response shape; then an adapter |
| `anysearch` | general | — | api_key | A publicly verifiable official API doc |
| `gemini` | ai | <https://ai.google.dev/gemini-api/docs/google-search> | api_key | A grounding adapter (answers + citations, not a SERP); Phase 2 |
| `grok` | ai | <https://docs.x.ai/docs/guides/live-search> | api_key | A model-search adapter; response is an answer with citations |
| `minimax` | ai | <https://platform.minimaxi.com> | api_key | Confirmation of which endpoint actually offers web search |
| `mimo` | ai | — | api_key | Confirmation that a public web-search interface exists |
| `deepseek` | ai | <https://api-docs.deepseek.com> | api_key | Nothing to adapt: DeepSeek has no standalone web-search API. It is used as a chat/embedding model instead |
| `doubao` | ai | <https://www.volcengine.com/docs/82379> | api_key | Account-level verification of the Ark web-search plugin contract |
| `yuanbao` | ai | — | api_key | A public developer search API |
| `bailian` | ai | <https://help.aliyun.com/zh/model-studio> | api_key | The exact RAG/web-search endpoint per account permission |
| `qianfan` | ai | <https://cloud.baidu.com/doc/WENXINWORKSHOP> | api_key | A standalone web-search API (Qianfan is a model platform) |
| `stepfun` | ai | <https://platform.stepfun.com> | api_key | Confirmation of the web-search endpoint and response shape |

## Catalog-only entries — no official API

| Type | Category | Official docs | Auth | Missing for `live_tested` |
|---|---|---|---|---|
| `duckduckgo` | general | <https://duckduckgo.com/api> | none | Only the Instant Answer API exists; HTML scraping violates their terms. Cannot become `live_tested` as a general web search |
| `baidu` | general | — | api_key | No public general web-search API. Covered indirectly via a self-hosted SearXNG |

## Compatibility gateway presets (declarative only)

These are names imported from the previous private gateway. They have **no builtin adapter** — users must supply endpoint + field mapping through Generic HTTP/JSON.

| Type | Category | Auth | Missing for `live_tested` |
|---|---|---|---|
| `search-gateway` | compat | bearer | A reachable endpoint and a working field mapping; verification belongs to the operator |
| `alt-search-gateway` | compat | bearer | Same as above |
| `premium` | compat | api_key | Same as above |
| `orz-fetch` | compat | api_key | Same as above |
| `union-free` | compat | api_key | Same as above |
| `zhihu-radar` | compat | api_key | Same as above |
| `gpt55` | compat | api_key | Same as above |

## Producing live evidence

```bash
# Missing key => prints "SKIPPED: no credential" and exits 2 (never 0).
TAVILY_API_KEY=... corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider tavily
BOCHA_API_KEY=... corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider bocha
BRAVE_API_KEY=... corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider brave
```

Exit codes: `0` = LIVE PASSED (both queries returned non-empty, `https`, non-placeholder URLs); `1` = FAIL (auth/transport/mapping); `2` = SKIPPED (no credential). The script never prints or writes the key.

After a passing run, change **only that provider's** catalog `verification` to `live_tested` and note the date and commit in `notes`. Anything else is a fabricated claim.
