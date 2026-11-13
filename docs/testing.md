# Testing

The suite is split by what it can prove. Mock-backed tests prove control flow and contracts; they do **not** prove a third-party API works.

```bash
pnpm test                     # Vitest: unit + integration
pnpm build && pnpm test:e2e   # Playwright (needs a browser)
bash tests/scripts/smoke.sh http://127.0.0.1:8787
```

## Layers

| Layer | Location | Proves | Does not prove |
|---|---|---|---|
| Unit | `tests/unit` | Scheduling math, dedupe, RRF, URL canonicalization, SSRF rules, crypto, provider/model mapping | Real vendor behaviour |
| Integration | `tests/integration` | Real Fastify app + real SQLite + real HTTP routes, auth, persistence, MCP | External networks |
| Concurrency | `tests/integration/concurrency.test.ts` | 100 simultaneous searches never exceed per-key limits; counters return to zero | Multi-process coordination |
| E2E | `tests/e2e` | First-run, login, providers, lab, theme, settings, integrations in a browser | Provider latency at scale |
| Smoke | `tests/scripts/smoke.sh` | Live process: setup → providers → keys → search → fault isolation → token → MCP | Anything requiring real vendor keys |

## What is covered (177 tests, 17 files)

**Scheduler and quotas** — `tests/unit/scheduler.test.ts`, `tests/unit/key-limits.test.ts`

- 100 concurrent acquires on 5 keys × 3 slots → exactly 15 leases; every key active; no key above 3.
- **Three-tier limits**: per-key concurrency peak is *exactly* 2 (not 1, not 3) under 100 concurrent acquires; the RPM window rejects the 11th request in 60s while concurrency is free; a daily quota of 3 accepts 3 and then rejects.
- `acquireWithReason` separates a saturated pool (`queue_timeout`) from an unusable one (`no_key`); a parked waiter is woken by `release()` in ~80ms instead of polling.
- Slot release is idempotent; daily quota reset; round-robin; failover; least-used; weighted distribution.
- 429 → cooldown honouring `Retry-After`; 401 → `invalid` until manual reset; repeated 5xx → breaker.

**Fault isolation matrix** — `tests/integration/fault-matrix.test.ts`

- Timeout / 401 / 429 / 5xx: 50 runs each against a broken source plus a healthy one. Success rate ≥99%, `stats.partial=true`, `failedSources` exactly the broken source with the expected code, and the healthy source's results always present.
- Malformed JSON from a real local HTTP server (`generic-http`) → `bad_request`, isolated, healthy source still returns.
- Every source broken → HTTP 503 + `status:"failed"` (no empty 200).

**Models (optional stages)** — `tests/unit/models.test.ts`, `tests/integration/model-degradation.test.ts`

- OpenAI-compatible chat, Anthropic message format, HTTP failure propagation; embedding dimension validation and batching; Cohere-compatible rerank ordering and truncation.
- Prompt-injection detection, boundary stripping, untrusted block, citation extraction, query rewrite fallback.
- A 500 from every model endpoint: rerank / embedding / summary each set `stats.degraded=true`, keep base results, and add a `*-model` error entry. No model configured → plain search unaffected.

**Security** — `tests/integration/security-hardening.test.ts`, `tests/unit/safe-fetch.test.ts`, `tests/unit/crypto.test.ts`

- Setup token file created 0600, anonymous setup → 403, concurrent setup → exactly one admin row, env token honoured.
- Host header: rebinding host → 403 before auth; allowlisted host accepted.
- CSRF required for cookie mutations; `X-Forwarded-For` ignored without a trusted proxy and honoured with one.
- guarded `lookup` returns the `all:true` array form (regression for ERR_INVALID_IP_ADDRESS), blocks non-allowlisted private hosts, re-validates redirects, enforces the size cap and the http/https policy.
- AES-256-GCM round trip; ciphertext never contains plaintext.

**MCP** — `tests/integration/mcp.test.ts`, `tests/integration/mcp-client.test.ts`

- Official `@modelcontextprotocol/client` over Streamable HTTP and stdio: 9 tools, `search_web` returns structured results with provider attribution, `get_search_sources` lists providers, empty query → readable error.
- Cross-transport parity: same URLs and same provider attribution.
- Unsafe Origin → 403; rebound Host → 403 before auth; session cookie without Bearer → 401.
- Legacy 2025-11-25 handshake and modern 2026-07-28 envelope; mixing them → 400.

**API** — `tests/integration/api.test.ts`, `tests/integration/search-errors.test.ts`, `tests/integration/legacy-migration.test.ts`

- Setup once; wrong password; CSRF; unauthenticated admin; unimplemented provider type; key masking and absence from the SQLite file; persistence across a real close/reopen.
- Fusion + dedupe; partial results; task retrieval; token scopes; revocation; dashboard aggregates; config export without secrets; OpenAPI paths.
- Cache hit marks `stats.cached` with a new task id; `skipCache` forces a live run.
- Legacy migration: dry-run writes nothing, apply requires confirmation, credentials in the payload never reach the response or the database, a second apply creates nothing.

**E2E** — `tests/e2e/admin.spec.ts`

- First run (with setup token) → dashboard empty state → add mock providers → search lab → theme toggle → settings saved → reload retains session.
- Catalog labels: unimplemented entries show "仅目录 · 未实现" and no "supports 30 sources" claim.

**Standalone scripts** (start their own instance, no external credentials)

| Script | Proves |
|---|---|
| `tests/scripts/smoke.sh` | setup token enforcement, providers, keys, search, fault isolation, token, MCP initialize |
| `tests/scripts/leak-scan.mjs` | no key material in any API response, the SQLite file (plaintext/Base64/hex) or logs |
| `tests/scripts/mcp-live.mjs` | HTTP and stdio via the official client, parity of results |
| `tests/scripts/live-search.mjs` | **real** HN queries, different result sets, REST/MCP agreement |
| `tests/scripts/clean-install.mjs` | install → build → prod-only install → boot → real search |

## What is not covered

| Gap | Reason | Status |
|---|---|---|
| Brave live API | No subscription key; the host is unreachable from this network | **BLOCKED** |
| SearXNG live instance | No self-hosted instance; public instances unreachable here | **BLOCKED** |
| Tavily / Bocha / Metaso | No keys; official contract not verified in this round | NOT IMPLEMENTED |
| OpenAI/Anthropic/Gemini/Jina/Cohere live | No vendor keys | Contract verified with local servers only |
| Docker image build / container restart | Docker Engine unavailable (WSL blocked by host security policy) | **BLOCKED** |
| Multi-instance quota | Redis coordination not implemented | Out of scope |
| Soak / memory-leak testing | No soak harness yet | Planned |
| Browser matrix | Chromium only | Firefox/WebKit not run |

**Never** treat a green mock-backed suite as evidence that a real vendor integration works. Hacker News is the only provider in this repository with a recorded live run.

## Running the smoke script

It creates an administrator and providers in the target instance, so use a **fresh** data directory.

```bash
SEARCH_HUB_DATA_DIR=./.data/smoke SEARCH_HUB_PORT=8787 \
  node --import tsx apps/api/src/index.ts &

bash tests/scripts/smoke.sh http://127.0.0.1:8787
```

It asserts:

1. `/api/health` is OK.
2. Setup succeeds once.
3. Session works.
4. Two mock providers can be created.
5. Provider self-test returns results.
6. Key list is masked and the plaintext key never appears.
7. Multi-source search returns results with no secret in the payload.
8. A broken provider produces `partial` with results from the healthy one.
9. Token-authenticated search works.
10. MCP `initialize` returns `serverInfo.name = search-hub`.

## Reproducing the concurrency claim

```bash
pnpm exec vitest run tests/unit/scheduler.test.ts tests/integration/concurrency.test.ts
```

The unit test asserts the exact number of leases (15 for 5 keys × 3) and that all keys are used, which rules out a global lock masquerading as a limiter. The integration test runs 100 real HTTP searches and checks that no secret appears in any response and that in-flight counts return to zero.

## CI

`.github/workflows/ci.yml` runs:

- lint (`oxlint`), typecheck (app + web), Vitest;
- an in-memory migration test;
- web build, Docker image build, container health check;
- Playwright E2E;
- `pnpm audit --audit-level high`.

If a job cannot run in your environment (for example no Docker daemon), say so in the PR instead of marking it passed.
