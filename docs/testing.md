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

## What is covered (1018 tests, 75 files)

### v0.1.10 bulk provider test (T01–T30)

Every one of the 30 acceptance cases maps to one file and one executable
assertion. Nothing is stubbed at the HTTP layer: a "probe" either reaches a
`http.createServer` on 127.0.0.1 or is injected through `app.inject` against a
real SQLite database. **No real vendor is contacted.**

| T | File | Case name | Key assertion |
|---|---|---|---|
| T01 | `tests/integration/provider-single-test.test.ts` | `T01 only HealthService.checkOne builds a probe config` | exactly one `provider_health_checks` row after `:id/test`; `rg "adapter.search\(" apps/api/src/routes` = 0 hits (scanned in the test) |
| T02 | same | `T02 a paginated source test issues more than one upstream request` | Brave stub + `searchConfig{targetResults:50,maxPages:3}`: `stub.hits() >= 2`, `body.requests >= 2`, `detail_json.requests >= 2` |
| T03 | same | `T03 single test equals checkOne for the same source` | `:id/test` and `checkOne` agree on `resultCount`, `cause` and request count |
| T04 | same | `T04 keeps the legacy fields, adds the conclusion fields and leaks no key` | 5 legacy fields keep their types; 7 new fields present; no plaintext, no ciphertext in the body |
| T05 | `tests/integration/provider-batch-preview.test.ts` | `T05 reports 12 testable / 5 without key / 3 disabled for 20 sources` | `eligible=12`, `noKey=3`, `noEnabledKey=2`, `disabled=3`; `paidRisk` flips with the switch |
| T06 | same | `T06 connect preview ignores the paid budget and never claims paid risk` | `kind=connect` → `paidRisk=false`, `estimatedPaidProbes=0`, `coolingSkipped=0` |
| T07 | same | `T07 paid probes disabled blocks a search run with 409` / `T07 an exhausted daily budget blocks a paid run before anything is spent` | 409 `validation_error`; no job row, no health row written |
| T08 | same | `T08 a preview writes neither health rows nor job rows` | row counts identical before/after both kinds |
| T09 | same + `tests/unit/provider-eligibility.test.ts` | `T09 the seven counters sum to total for a mixed scope` / `counts sum to total, whatever the mix of reasons` | 7 buckets sum to `total`, including cooldown + keyless-policy |
| T10 | `tests/integration/provider-batch-run.test.ts` | `T10 create returns a jobId, running status and the concurrency in use` | 201, `status=running`, DB row matches, `nextPollAfterMs=1000` |
| T11 | same | `T11 finished items are readable while the run is still running` | `status=running` **and** a row with `state=ok` + `checkId`, whose health row has `batch_id` |
| T12 | same | `T12 counts are monotonic and never exceed the total` | 5 polls: `done` never decreases, `done+skipped<=total` |
| T13 | same | `T13 cancel keeps finished items readable and marks the rest cancelled` | `status=cancelled`; finished rows keep the same `checkId`; remainder `SKIPPED_CANCELLED` with `checkId=null` |
| T14 | same | `T14 a restart marks the run interrupted and never completed` | second `createContext` on the same `dbPath` → `interrupted`, `!== completed`, `remaining>0` |
| T15 | same | `T15 the startup sweep is idempotent` | first sweep returns 1, second returns **0**, `finished_at` unchanged |
| T16 | same | `T16 in-flight probes never exceed the configured concurrency` | stub concurrency peak ≤ 2 at `concurrency=2`, ≤ 4 at `concurrency=4` |
| T17 | same | `T17 rejects concurrency above 4 and accepts exactly 4` | `5` → 400 `validation_error` and no row; `4` → 201 |
| T18 | same | `T18 a second job records the shared source as already_running` | second job's item `already_running`, `checkId=null`, stub hits unchanged, total hits = 1 |
| T19 | same | `T19 budget exhaustion skips the remainder with budget_exhausted` | remainder `SKIPPED_BUDGET` with `budget_exhausted` in `reason`; ledger not overspent |
| T20 | same + unit | `T20 the denominator is the testable count, not the scope` / `success-rate denominator` | `testable = total - skipped`; a `CONFIG_ERROR` counts, a skip does not |
| T21 | `tests/integration/provider-batch-run.test.ts` | `T21 a 200 with zero results becomes pending, not ok and not failed` | `state=pending`, `code=empty_results`, `ok`/`failed` unchanged, `done` +1, stored status still `degraded` |
| T22 | same | `T22 an undecryptable credential fails as configuration_error without leaking` | `failed` +1, `code=configuration_error`, `checkId=null`, stub hits 0, no ciphertext/plaintext/iv in the response or `items_json` |
| T23 | same | `T23 an invalid response body is a failed item, not an empty one` | 200 + `{"unexpected":true}` → `state=failed`, `code=invalid_response`, stored `cause=bad_response` |
| T24 | same | `T24 a running job satisfies the progress identities and is not completed` | `done+skipped+remaining===total`, `ok+failed+pending===done`, `status!=="completed"` |
| T25 | `tests/e2e/provider-batch.spec.ts` | `T25 预检框显示 6 行计数与预算，付费提示按 kind 出现` | six count rows + budget visible; `paidRisk` absent for `connect`, present for `search` once the switch is on |
| T26 | same | `T26 确认→进度可见→取消→结果表仍保留已完成行` | progress visible → cancel → results table keeps `data-state="ok"` rows; label is "partially complete" |
| T27 | same | `T27 结果表按失败→受限→待确认→成功→跳过排序` | five distinct `data-state` values in non-decreasing severity order |
| T28 | same | `T28 只重测失败项时请求体恰好是失败集合` | intercepted POST body `providerIds` equals the failure set exactly — no throttled, no ok |
| T29 | same | `T29 抽屉显示脱敏 Key 标签、样例不超过 3 条、requests 缺失显示 —` | `key_ab…9f` shape, ≤ 3 samples, `requests` renders `—`, no key material anywhere |
| T30 | same + `tests/unit/i18n-parity.test.ts` + `tests/unit/provider-batch-view.test.ts` | `T30 英文界面下批量体检文案无硬编码中文` / parity / message coverage | `zh`/`en` key sets equal, no CJK in the dialog in English, every classification has a label and an advice sentence in both locales |
| T31 | `tests/e2e/provider-batch.spec.ts` | `T31 页面顶部「全部测试」打开同一个预检框` | the page-header entry opens the **same** pre-flight dialog (same count rows, same scope line); closing it leaves no dialog behind |
| T32 | same | `T32 刷新后提示条出现并能打开上次检测结果` | a real run → reload → the notice describes the server's status → opening it shows the result table from the *same* job id |
| T33 | same | `T33 任务不存在时静默清除，不显示提示条也不报错` | a pointer to a job the server does not have produces no notice, no error alert, and is dropped from `localStorage` |
| T34 | same | `T34 结果表 8 列，1600×1000 下操作列完整可见且无横向溢出` | exactly eight `<th>`; no `batch-requests-*` cell; `scrollWidth <= clientWidth`; both row actions inside the dialog box; a row retest opens the single-source dialog and leaves the batch row untouched |
| T35 | `tests/e2e/provider-single-test.spec.ts` | `T34 单源测试通过：结论、结果数、测试时间与脱敏 Key，页面无 Key 明文` | pass path through the row button: `返回结果=3`, `requests=—` for a mock, `checkedAt` present, no plaintext key, health overview `healthy` after reload |
| T36 | same | `T35 单源测试的上游请求数是真实测量，并写回健康概览` | a loopback HN stub: `requests` equals what the stub's socket counted, results = stub's rows, health flips to `healthy` |
| T37 | same | `T36 单源测试失败：显示鉴权分类与建议，而不是笼统失败` | a real 401 from a loopback stub → "测试失败" + `Key 无效或已过期` + advice; health shows `invalid_credentials` |
| T38 | `tests/e2e/provider-batch.spec.ts` | `T34`（同上） | the retest dialog is the **same** surface as the row's test button, so a retest reads identically wherever it starts |

The E2E suite seeds only the built-in `mock` adapter and one `http.createServer`
Brave-shaped stub on 127.0.0.1; `paidProbesEnabled` is switched on for the
`paidRisk` case, which is safe precisely because no vendor is reachable.

**Bulk test data path** — `tests/unit/batch-migration.test.ts` (4 cases):
migration `0008` keeps v0.1.9 health rows with `batch_id NULL`, creates the
ledger with the defaults the runner relies on, adds both indexes, and applies
twice without error.

**Eligibility decisions** — `tests/unit/provider-eligibility.test.ts` (11 cases):
the 20/12/5/3 scenario against real rows, the counter partition, decision order
(disabled outranks a missing adapter), a decrypt failure that counts without
leaking, and the paid budget not applying to a keyless source.

**Result-table classification** — `tests/unit/provider-batch-view.test.ts`
(9 cases): restricted vs failed, severity ordering with `null` latency last, the
retry-failure and retry-pending sets, `—` for a missing request count, key-id
redaction, and message coverage for every code in both locales.

## Malformed request mapping — `tests/integration/http-error-mapping.test.ts` (5 cases)

Fastify rejects some requests before a handler runs. Those errors carry a 4xx
`statusCode`, and the global handler used to fold everything that was not a
`SearchHubError`, a `ZodError` or a 429 into `500 internal_error`. A caller with
an empty JSON body was therefore told the server had broken, and routine bad
traffic was logged at error level. Found while acceptance-testing the published
v0.1.7-beta.2 Windows package (`curl -X POST -H 'content-type: application/json'`
with no body returned 500). Now: empty body → 400, invalid JSON → 400,
unsupported media type → 415, body over the 2 MiB limit → 413, all with a stable
`bad_request` code and a debug-level log; a genuine internal failure still
returns 500.

**Credential classes** — `tests/integration/credential-classes.test.ts` (6 cases)

- The catalogue and every adapter agree on which sources take a key: the six
  public ones declare `authType: none` and `requiresKey: false`, and `brave` /
  `tavily` declare the opposite.
- A key-required source with no key is `unverified`, never healthy.
- A keyless source is probed for real (a local stub serving the HN wire format),
  can report healthy, is listed as `ready`, and is counted by `/api/health`
  instead of inflating a "no key" failure.
- A source that needs its own instance (SearXNG without a base URL) is a
  configuration problem, not a keyless success.

**Real network failures** — `tests/integration/network-failures.test.ts` (8 cases)

Every case opens a real socket or deliberately fails to; nothing asserts on a
hand-written error string:

- `.invalid` hostname → real resolver failure → `dns`
- self-signed certificate on a local HTTPS server → `tls` (the OpenSSL code is
  found in the wrapped cause chain)
- TLS against a plaintext port → handshake never completes
- closed port → `network`
- server that accepts and never answers → the request deadline really fires
- HTML where JSON is expected → `bad_response`, never healthy
- abort mid-flight → `cancelled`, no cooldown
- redirect into a private address → refused by the guard before connecting

**i18n parity** — `tests/unit/i18n-parity.test.ts` (5 cases) plus the browser
switch test in `tests/e2e/admin.spec.ts`: full key coverage, zero CJK in the
English values, identical `{{placeholders}}`, no empty strings, no hardcoded
zh-CN formatter, and a real switch → reload → switch-back cycle that asserts no
Chinese remains in `<main>`.

**Request budget and request isolation** — `tests/integration/upstream-request-budget.test.ts` (10),
`tests/integration/search-request-isolation.test.ts` (7),
`tests/integration/search-task-persistence.test.ts` (4),
`tests/integration/quality-accounting.test.ts` (9)

These are the ones where a stubbed fetch would have proved nothing, so each assertion
is against a real HTTP server on 127.0.0.1 that counts what it served:

- One page is one request; three pages are three; one logical call that paginates is
  one adapter attempt and three requests. A redirect costs two. A hop refused by the
  outbound policy costs zero. A request already on the wire is not refunded when the
  caller aborts. Twenty concurrent pages under a ceiling of five leave the stub having
  served exactly five.
- Health-gate isolation is reproduced with a slow provider holding one request inside
  the fan-out while a second completes, not with random sleeping: a request keeps its
  own skip list, a clean request is not given another's, two requests skipping different
  sources do not swap, 100 interleaved requests stay separate, a cache hit re-applies
  only the current gate, and Deep Search reports the parked source once.
- A search rejected by the gate now leaves a queryable `failed` task; another actor
  gets 404; evaluation traffic writes no task; a partial search is stored as partial.
- Run accounting: a paginated provider's spend is the wire count, the ceiling stops a
  redirect-driven overspend, failure is not success, latency is bound to its query, and
  an offline re-rank reports no latency at all.

**Release channel** — `tests/unit/release-channel.test.ts` (8 cases)

The workflow used to hardcode `prerelease: true`, so a stable tag could never be published
as stable. The classification now lives in `packaging/release-channel.mjs` and is asserted
here: `v0.1.8` → stable, `v0.1.8-beta.1` / `-rc.N` / `-alpha.N` → prerelease, and anything
unrecognised (`v0.1.8-nightly.1`, `v0.1`, `0.1.8`) is rejected rather than guessed. Ordering
is checked too, because "is this newer than the installed version" is what the updater
relies on.

**Search quality lab** — `tests/unit/quality-metrics.test.ts` (42 cases),
`tests/unit/quality-migration.test.ts` (4), `tests/unit/quality-gate.test.ts` (4) and
`tests/integration/quality-lab.test.ts` (36)

Metric maths is asserted against hand-computed values, not against the implementation:

- P@10 keeps the cutoff as denominator (3 relevant of 10 is 0.30, not 1.0); Recall@10 uses
  the qrels total and is N/A when the qrels are incomplete or hold nothing relevant;
  MRR@10 covers position 1, 3, 10 and the no-hit case; nDCG@10 is exactly 1 for an ideal
  ordering, lower when reversed, and N/A when every grade is 0.
- Unjudged documents are excluded from the ranking (and the query marked provisional), not
  scored as 0; `as_zero` is available only as a sensitivity view and lowers the score.
- Aggregation leaves provisional queries out of the headline, reports how many it left out,
  and returns N/A when every query is provisional. `lowSample` flips at 8.
- Cost is `unknown` — never 0 — when no unit price is configured.
- The fusion lab re-ranks a snapshot through the production `dedupeResults` and
  `orderByBaseRanking`; a provider returning the same URL twice is counted once; ties break
  deterministically.
- Dataset API: create, add queries, reject a duplicate query, replace a re-graded document
  instead of duplicating it, freeze, refuse edits after freezing, fork, export/import round
  trip, reject an out-of-range grade.
- Runs: the offline fixture completes with **no provider configured** (so nothing could have
  left the process), identical snapshots produce identical metrics, a re-rank issues zero
  requests, live mode refuses without `confirmPaid` / providers / a workable budget, a live
  run against the local `mock` adapter writes no `search_tasks` row, an unfrozen dataset and
  a manual dataset without snapshots are both refused.
- Authorization: 401 without a session, 403 for a `search`-scope token, 403 without CSRF.

**Provider health management** — `tests/integration/provider-health-center.test.ts` (35 cases)

- Implementation verification and runtime health are independent: a green probe does not
  upgrade `documented`/`mock_verified`, and the panel shows both.
- No API key ⇒ `unverified` before any request leaves the process; a disabled provider is
  `disabled` whatever the last probe said.
- The two probe kinds are distinct: `connect` proves reachability, `search` is the only one
  that can claim "it can search".
- Cause classification covers 401 / 403 / 429-limited / 429-quota / 5xx / DNS / TLS /
  timeout / empty results; only quota and invalid credentials gate a search.
- Budget: 3 per run, 20 per UTC day, persisted across a restart, and **100 concurrent paid
  probes never exceed the ledger** (exactly 5 of 100 accepted with a cap of 5).
- Backoff and recovery: consecutive failures raise the backoff level and schedule a retry
  sooner than the interval; one success clears both.
- One dead key does not disable a provider; every key rejected reports
  `invalid_credentials`, never `healthy`.
- Lifecycle: two passes cannot probe the same provider at once; stopping the scheduler ends
  the timer and no further probes are written; the timer does not keep the process alive.
- The API never returns key material, an unauthenticated caller gets 401/403, a
  `search`-scope token gets 403, and reset parks nothing but also re-enables nothing.
- A cache hit fabricates no health: no probe row, no success count, runtime stays `unknown`.
- MCP and REST see the same gate and the same skip reason.

All of it runs on injected clocks with a controllable scheduler — no test waits for a real
interval, and no test calls a paid vendor.


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
| Docker image build / container restart | **本机** Docker Engine unavailable (WSL blocked by host security policy) | **BLOCKED locally; PASS in GitHub Actions** — run [43582011942](https://github.com/alicia1030su/search-hub/actions/runs/43582011942), 24/24, see `docs/docker-verification.md` §3.2 |
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
