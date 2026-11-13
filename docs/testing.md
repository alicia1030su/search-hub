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

## What is covered (139 tests)

**Scheduler (`tests/unit/scheduler.test.ts`)**

- 100 concurrent acquires on 5 keys × 3 slots → exactly 15 leases; every key active; no key above 3.
- Slot release is idempotent; RPM window; daily quota reset; round-robin order; failover preference; least-used choice; weighted distribution.
- 429 → cooldown honouring `Retry-After`; 401 → `invalid` until manual reset; repeated 5xx → breaker cooldown; all-cooling → `null` instead of endless retry.

**Fusion (`tests/unit/fusion.test.ts`)**

- Tracking parameters removed, query sorted, default port and fragment removed.
- Exact URL merge keeps both sources; near-title merge on the same domain; cross-domain titles are not merged.
- RRF matches `2/61` for a document ranked first by two providers; order-independent; multi-source results outrank single-source.

**SSRF (`tests/unit/ssrf.test.ts`)**

- Loopback, RFC1918, CGNAT, link-local, metadata, IPv6 ULA/link-local, IPv4-mapped IPv6 blocked.
- Metadata IP blocked even when allowlisted; exact/suffix allowlist semantics.
- Runtime: loopback blocked before a socket opens; redirect re-validation catches a private hop; size cap; timeout.

**Providers (`tests/unit/providers.test.ts`)**

- SearXNG happy path, JSON-disabled 403 hint, malformed payload, missing base URL.
- Brave header/query mapping, missing key, 401 → `auth_invalid`, 429 + `Retry-After` → `rate_limited`.
- Generic mapping (header key injection, nested results path), invalid mapping rejection, missing path error.
- Mock determinism and failure modes.

**Models (`tests/unit/models.test.ts`)**

- OpenAI-compatible chat, Anthropic message format, HTTP failure propagation.
- Embedding dimension validation, batching, cosine similarity.
- Cohere-compatible rerank ordering, document truncation.
- Prompt injection detection, boundary marker stripping, untrusted block in the prompt, citation extraction.
- Query rewrite JSON parsing and fallback; embedding re-scoring.

**API (`tests/integration/api.test.ts`)**

- Setup exactly once; wrong password rejected; CSRF required; unauthenticated admin rejected.
- Unimplemented provider type rejected; key masked in responses and absent from the SQLite file (plaintext and base64).
- Provider/settings persistence across a real close/reopen.
- Multi-source fusion + dedupe; partial results with visible failure; task retrieval; token scopes; revocation.
- Dashboard aggregates; config export without secrets; OpenAPI paths; setup token.

**Errors and hardening (`tests/integration/search-errors.test.ts`)**

- All providers failing → HTTP 503 + `failedSources`; one failing → 200 partial.
- Missing key → `auth_invalid` with actionable message.
- Global timeout returns before the slow provider's own timeout.
- RPM burst hits 503 after the configured window.
- Cache hit returns `stats.cached` and a new task id; different queries miss.
- Login throttling → 429; MCP endpoint absolute.

**MCP (`tests/integration/mcp.test.ts`)**

- Bearer required; legacy `initialize` + `tools/list` (9 tools); `tools/call` through the shared core.
- Modern 2026-07-28 envelope with `MCP-Protocol-Version` + `Mcp-Method` + `Mcp-Name` + `_meta`.
- Mixing a legacy handshake with a modern header → 400 with a mismatch message.
- Status tools contain no key-like strings.

**Concurrency (`tests/integration/concurrency.test.ts`)**

- 100 parallel searches on 2 keys × 2 slots: all succeed, no key leaks, in-flight returns to zero, total not serialized.

**E2E (`tests/e2e/admin.spec.ts`)**

- First-run → dashboard empty state → add two mock providers → search lab shows both → theme toggle → settings saved → reload retains session and value.
- Unauthenticated redirect; wrong-password message; integrations page shows `/mcp` and `search_web` without `sk-`.

## What is not covered

| Gap | Reason | Status |
|---|---|---|
| Brave live API | No subscription key | Documented as “not integration-tested” |
| SearXNG live instance | No instance available | Documented |
| OpenAI/Anthropic/Gemini/Jina/Cohere live | No vendor keys | Contracts tested with local servers |
| Docker image build | Docker daemon unavailable in the development environment | CI job provided; not executed here |
| Multi-instance quota | Redis coordination not implemented | Out of scope for 0.1.0 |
| Long-running soak / memory leaks | No soak harness yet | Planned |
| Browser matrix | Chromium only | Firefox/WebKit not run |

**Never** treat a green mock-backed suite as evidence that a real vendor integration works. When reporting status, separate “contract verified with a mock” from “verified against the provider”.

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
