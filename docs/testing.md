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

## What is covered (366 tests, 25 files)

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

**Models (optional stages)** — `tests/unit/models.test.ts`, `tests/integration/model-degradation.test.ts`, `tests/integration/model-security.test.ts`

- OpenAI-compatible chat, Anthropic message format, HTTP failure propagation; embedding dimension validation and batching; Cohere-compatible rerank ordering and truncation.
- Prompt-injection detection, boundary stripping, untrusted block, citation extraction, query rewrite fallback.
- A 500 from every model endpoint: rerank / embedding / summary each set `stats.degraded=true`, keep base results, and add a `*-model` error entry. No model configured → plain search unaffected.
- **Model chain security (`model-security.test.ts`, 24 cases)** — a custom model Base URL is rejected at creation time when it is a private address and not allowlisted (403, no socket opened), accepted after `settings.security.privateHostAllowlist` includes it, blocked again as soon as the allowlist is revoked (policy is re-evaluated per call), and the cloud metadata endpoint stays blocked even when allowlisted in any spelling (`169.254.169.254`, `[::ffff:169.254.169.254]`, `100.100.100.200`) — including a model inserted through `/api/admin/config/import`, which bypasses the route check. `file://` / `ftp://` / `gopher://` Base URLs are rejected by the `httpUrl` schema.
- **API key protection** — the plaintext key never appears in the create response, the model list, `/api/admin/config/export` or the `/api/admin/backup` snapshot (latin1 scan); the UI hint exposes at most 4+4 characters. An upstream that echoes the credential in a 401/400 body is scrubbed twice: `SafeFetch` redacts the headers it knows and `packages/models/src/redact.ts` scrubs against the exact key, which is what closes the `x-goog-api-key` (Gemini) gap that `SafeFetch`'s header list does not cover.
- **Single HTTP client** — a counting fetch injected into `ModelService` proves every model call goes through it (a chat summary through `/api/search` shows exactly one call); `allowHttp=false` blocks a model call, which only `SafeFetch` can enforce; a deployment proxy receives a `CONNECT 1.2.3.4:8080` for a model request, so the model path shares the provider egress path; `mode=basic` against an allowlisted local model server produces zero hits; the model sources are asserted to contain no `undici`, `node:http(s)`, `axios` or `globalThis.fetch`.
- **Protocol contracts** — Anthropic `/v1/messages` (system hoisted, `x-api-key`, no Bearer), Gemini `models/{id}:generateContent` (`contents`, `generationConfig`), embedding dimension mismatch → 200 + `degraded=true` with a message naming both numbers, matching dimensions → `embeddingApplied=true` and similarity re-ordering, Cohere-compatible rerank index→URL mapping with `rerankScore` ordering, malformed rerank JSON → degraded with unchanged results, and summary citations that keep only `[n]` present in `results` (a model-invented `[9]` is dropped, the text is kept verbatim).

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
| `tests/scripts/search-quality.mjs` | multi-source quality **numbers** on a live instance (per-provider + fused counts, valid URLs, duplicate rate, latency, failure codes); refuses to call mock output real evidence (exit 3) |
| `tests/scripts/ac05-concurrency.mjs` | AC-05 elapsed-time budget `⌈100/6⌉ × latency ±20%` and cross-key in-flight overlap measured against the real scheduler |
| `tests/scripts/perf-breakdown.mjs` | AC-05 layered timings (fan-out, fusion, SQLite `dbWriteMs`, HTTP overhead, queue), P50/P95/P99, and the 100-request burst ratio |
| `tests/scripts/skills-verify.mjs` | static SKILL.md checks plus the documented REST calls against a live instance; proves a search-scope token cannot read admin models and that a missing token fails |
| `tests/scripts/backup-restore.mjs` | backup under concurrent writes (3 downloads, `integrity_check`, ciphertext-only keys), restore into a fresh directory with `master.key`, newer-schema refusal at boot, and failure handling (no published file when the backup path is unusable or the process is killed mid-snapshot) |

`scripts/ac-matrix.mjs` validates and renders the acceptance matrix from
`docs/ac-matrix.json` (the single source of truth for AC-01..AC-16):

```bash
node scripts/ac-matrix.mjs           # validate + write docs/ac-matrix.md
node scripts/ac-matrix.mjs --check   # CI gate, writes nothing
```

`tests/unit/ac-matrix.test.ts` locks the matrix down: exactly 16 entries, ids
`AC-01`..`AC-16` in order, one valid status each, `PASS` with a real
`command → result` evidence pair, every non-PASS entry with a gap, plus a
negative test per rejection path (15 items, unknown status, out-of-order id,
PASS without evidence, PARTIAL/BLOCKED without gaps, empty evidence fields).
It also asserts that the single tally quoted in `docs/acceptance-report.md`
still equals the counts derived from the JSON, so the two files cannot drift.


## What is not covered

| Gap | Reason | Status |
|---|---|---|
| Brave live API | No subscription key; the host is unreachable from this network | **BLOCKED** |
| SearXNG live instance | No self-hosted instance; public instances unreachable here | **BLOCKED** |
| Tavily / Bocha live API | Adapters implemented and covered by local contract tests (`tests/unit/providers-web-search.test.ts`); no account key, so `provider-live.mjs` exits 2 (SKIPPED) | **BLOCKED** (no credential) |
| Metaso | Catalog-only, no verified official endpoint | NOT IMPLEMENTED |
| OpenAI/Anthropic/Gemini/Jina/Cohere live | No vendor keys. Reachability probed from this host: Cohere answers 403 for a bad key (<3s), Jina/OpenAI time out at 12s | Contract verified with local servers only |
| Docker image build / container restart | Docker Engine unavailable on this host (WSL blocked by host security policy) | **BLOCKED locally** — automated in CI, see `docs/docker-verification.md` |
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
node --import tsx tests/scripts/ac05-concurrency.mjs --runs 3
```

The unit test asserts the exact number of leases (15 for 5 keys × 3) and that all keys are used, which rules out a global lock masquerading as a limiter. The integration test runs 100 real HTTP searches and checks that no secret appears in any response and that in-flight counts return to zero. `ac05-concurrency.mjs` measures the half the unit test does not: elapsed time must be within ±20% of `⌈100/6⌉ × measured latency`, and in-flight windows from different keys must actually overlap.

## Measuring search quality (numbers only)

```bash
# needs a live instance and a token with search + sources:read
node tests/scripts/search-quality.mjs --url http://127.0.0.1:8830 --token sh_xxx \
     --out docs/search-quality-report.md [--rerank-model <model-id>]

# exit 3 + a loud WARNING when every enabled source is `mock`:
# that run is a contract test, not evidence about the real web.
```

The script writes a markdown table plus `docs/search-quality-report.json`. It reports per-source and fused counts, valid absolute URLs (excluding `example.com`), duplicate rate, server-side `stats.timing.totalMs`, client wall time and failure codes. It deliberately contains no relevance score: judging "which result is better" needs a labelled ground-truth set, which this repository does not have. A single-source run (Hacker News only) says nothing about general web search quality, and the report says so in its own words.

Exit codes: `0` every fused query returned a usable result set; `2` configuration/auth problem; `3` every enabled provider is `mock` (not real web-search evidence); `4` every fused query failed (upstream outage — the report is still written, so the failure codes are preserved). **A CI job must treat 3 and 4 as failures**, otherwise an outage or a mock-only run reads as a green quality gate.

## CI

`.github/workflows/ci.yml` runs:

- lint (`oxlint`), typecheck (app + web), Vitest;
- an in-memory migration test;
- web build, artifact presence checks, production-only (`--prod`) install and boot;
- Playwright E2E;
- `pnpm audit --audit-level high`.

`.github/workflows/docker.yml` runs the container acceptance: image build with layer
cache, `docker compose config`, the 10-item `scripts/docker-verify.sh`
(live search, restart, persistence, resource footprint, crash recovery), and a
trivy HIGH/CRITICAL gate. It is a separate workflow so a container failure is never
confused with a host-tree failure. Details: [`docker-verification.md`](./docker-verification.md).

If a job cannot run in your environment (for example no Docker daemon), say so in the PR instead of marking it passed.
