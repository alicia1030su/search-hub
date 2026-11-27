# Testing

The suite is split by what it can prove. Mock-backed tests prove control flow and contracts; they do **not** prove a third-party API works.

```bash
pnpm test                     # Vitest: unit + integration
pnpm test:cli                 # CLI-only unit + integration
pnpm build && pnpm test:e2e   # Playwright (needs a browser)
bash tests/scripts/smoke.sh http://127.0.0.1:8787
```

## Disaster-recovery tests

All disaster-recovery runs use isolated temporary databases, synthetic keys, dynamic ports and disposable containers/units. Never point these commands at a production data directory, Docker volume, systemd unit, tag or release.

### Fast local contract tests

```bash
pnpm exec vitest run tests/unit/backup-package.test.ts tests/unit/backup-snapshot.test.ts \
  tests/unit/cli/backup.test.ts tests/integration/backup.test.ts
node tests/disaster-recovery/backup-performance.mjs --self-check
node --expose-gc --import tsx tests/disaster-recovery/backup-memory-loop.mjs --self-check
```

These tests cover fixed-member age packages, default work-factor enforcement, strict tar/path/link/duplicate/trailing-data rejection, SQLite sealing and real AES-GCM sample decryption, wrong/missing keys, upload authentication before disk writes, API/CSRF, CLI create/verify/dry-run/apply, and repeated-restore refusal. A local PASS is not a platform or release PASS.

### Packaged CLI resource and offline verification

`backup-performance.mjs` creates real SQLite fixtures and drives the public CLI. The default schedule is 10/64/128/256 MiB with one warm-up, five measured repeated rounds and five fresh-process controls. The 128 MiB case is the R20 offline-verify fixture; 10/64/256 MiB are the resource matrix. It records stage/operation time, process-tree RSS/peak/private memory, heap/external sidecars, CPU, handles, temporary/owned disk peaks, age work factor, source/package/restored-DB SHA256, redacted logs, `manifest.json` and `SHA256SUMS`.

```bash
node tests/disaster-recovery/backup-performance.mjs --help
node tests/disaster-recovery/backup-performance.mjs --self-check

# Full serial run against the final packaged CLI (not the TypeScript source entry).
node --import tsx tests/disaster-recovery/backup-performance.mjs --run \
  --cli /path/to/packaged/shub --sizes 10,64,128,256 \
  --rounds 5 --warmup 1 --fresh-rounds 5 \
  --output-dir artifacts/disaster-recovery/v0115-full

# Optional 256 MiB single-round smoke. This is deliberately BLOCKED, not acceptance.
node --import tsx tests/disaster-recovery/backup-performance.mjs --run \
  --cli /path/to/packaged/shub --single-round \
  --output-dir artifacts/disaster-recovery/v0115-256-smoke
```

The performance manifest is **sub-evidence only**. Its `requirements` object contains R01–R38/A01–A12, but uncovered entries stay `NOT TESTED`. R20 may pass from the real 128 MiB offline run. By default, before deleting the first 10/64/256 MiB round's package, the harness also runs an integrated same-process verifier loop and writes independent `reports/memory-loop-<size>/manifest.json` + `SHA256SUMS`; `--no-memory-loop` disables this and leaves R34 `BLOCKED`. R34 stays `BLOCKED` in the performance manifest itself and is passed only when the aggregator sees both `performanceSubset=PASS` and the independent same-process report PASS. A04/A11 also stay `BLOCKED` until their independent legacy/M04/fault/full-regression/platform evidence exists. Do not use the performance manifest directly as the release DR gate.

### Same-process retained-memory verification

Fresh CLI processes cannot prove that a long-lived verifier releases memory. `backup-memory-loop.mjs` calls `verifyDatabaseBackup` repeatedly in one Node process and records `heapUsed`, `heapTotal`, `external`, `arrayBuffers`, RSS, maxRSS, active-handle count/types, Linux FD count, per-round temporary cleanup and source/package hashes. Final evidence uses the default `final` adapter; `current` is development-only and is not a release mode.

```bash
node --expose-gc --import tsx tests/disaster-recovery/backup-memory-loop.mjs --help
node --expose-gc --import tsx tests/disaster-recovery/backup-memory-loop.mjs --self-check

# Run once for each real 10/64/256 MiB package + its source DB.
node --expose-gc --import tsx tests/disaster-recovery/backup-memory-loop.mjs --run \
  --package /isolated/10MiB.shbackup --source-db /isolated/10MiB-source.db \
  --passphrase-file /isolated/0600-passphrase --adapter-mode final \
  --rounds 5 --warmup 2 \
  --output-dir artifacts/disaster-recovery/v0115-memory-10
```

A passphrase file must be a regular 0600 file on POSIX; `SEARCH_HUB_BACKUP_PASSPHRASE` is the environment fallback. The growth rule fails sustained monotonic growth whose total exceeds 10× warm-up/MAD noise; ambiguous high-noise growth is `BLOCKED`. Current-RSS or heap-capacity movement with a stable maxRSS and stable used-heap/external/active handles is classified as allocation noise, not a leak. There is no fabricated RSS≤64 MiB threshold and the age KDF is never lowered.

### R01–R38 / A01–A12 evidence aggregation

The release gate is produced only after every requirement has real evidence:

```text
docs/evidence/v0.1.15/disaster-recovery/gate.json
docs/evidence/v0.1.15/disaster-recovery/SHA256SUMS
```

`gate.json` must use `schemaVersion=1`, `suite=search-hub-disaster-recovery-v0.1.15`, exact `releaseCommit` and `releaseCodeFingerprint`, `verdict=PASS`, exactly R01–R38/A01–A12 all `PASS`, and at least one relative evidence reference per id. Every referenced file must be listed in `SHA256SUMS`. Validate the finished gate with:

```bash
node packaging/verify-disaster-recovery-evidence.mjs --commit "$(git rev-parse HEAD)"
```

`tests/disaster-recovery/requirement-matrix.json` maps every R01–R38/A01–A12 id to its command, isolated fixture, expected evidence and platform. Platform scripts write an aggregator-compatible `report.json` through `write-platform-report.mjs`; only requirements actually proven by that run are marked PASS, and all others remain NOT TESTED. Performance and memory-loop manifests are inputs to the aggregator, never replacements for it. Missing evidence is `NOT TESTED`; an executed but resource/telemetry-blocked case is `BLOCKED`; a missing implementation is reported as `NOT IMPLEMENTED`/`BLOCKED` with the reason. Never convert any of these to `PASS`. A12's pre-tag PASS covers exact-SHA candidate aggregation, the five successful main-push gates and the candidate/promoter policy; the sixth candidate workflow, immutable annotated tag and digest-fixed promotion are verified by the subsequent preflight and release gates.

### Platform-isolated commands

#### Windows x64

```powershell
powershell -NoProfile -File tests/disaster-recovery/platform-windows.ps1 `
  /path/to/extracted/search-hub-windows-x64 /path/to/packaged/shub.exe `
  artifacts/disaster-recovery/platform-windows
node packaging/verify-package.mjs windows-x64
```

`platform-windows.ps1` runs the packaged runtime and `shub.exe` through create/verify/default dry-run/apply with `--start-check`, then starts the restored service and verifies health, login, provider, key decryption, search and MCP. It also exercises non-empty and repeated targets, an ancestor junction, NTFS ACL readback, and a long Unicode path. It writes `report.json` and `SHA256SUMS`. If a required Windows feature cannot be exercised, record `BLOCKED`, not PASS.

#### Linux x64 and arm64

```bash
bash tests/disaster-recovery/platform-linux.sh \
  /path/to/extracted/search-hub-linux-x64 /path/to/packaged/shub \
  artifacts/disaster-recovery/platform-linux-x64
bash tests/disaster-recovery/platform-linux.sh \
  /path/to/extracted/search-hub-linux-arm64 /path/to/packaged/shub-arm64 \
  artifacts/disaster-recovery/platform-linux-arm64
node packaging/verify-package.mjs linux-x64
node packaging/verify-package.mjs linux-arm64
```

The script starts the packaged source server on a dynamic port, creates a synthetic admin/provider/key/search history, stops it, runs packaged CLI create/verify, asserts default dry-run leaves no target, runs apply with `--start-check`, starts the restored packaged server, checks `/api/health`, and verifies login, provider, key decryption, search and MCP through `api-fixture.mjs`. It records hashes/modes and `SHA256SUMS`. Run x64 and arm64 on their real architectures as a non-root user. CLI create/verify/restore run with `PATH=/nonexistent` to prove the standalone binary does not depend on host Node/pnpm.

#### Docker

```bash
docker build --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  -t search-hub:v0115-candidate .
bash tests/disaster-recovery/platform-docker.sh \
  search-hub:v0115-candidate /path/to/packaged/shub \
  artifacts/disaster-recovery/platform-docker
bash scripts/docker-verify.sh
```

`platform-docker.sh` creates a unique project/network and three disposable volumes (production source, package output, restore target). It starts the source container as uid 1001 with a read-only rootfs and dynamic host port, seeds synthetic state, stops it, mounts the packaged CLI read-only into an offline `--network none` container, runs create/verify, proves dry-run leaves the restore volume empty, runs apply with `--start-check`, then starts a second container on the restore volume. It checks health/login/provider/key-decrypt/search/MCP and compares production-volume hashes before/after. Cleanup removes only the named project resources. Docker evidence remains linux/amd64; standalone arm64 does not replace it.

#### systemd and updater rollback

Run only in a disposable VM or container whose PID 1 is real systemd. The script creates custom source/restored units, explicit data/DB paths and dynamic ports; it never edits the production `search-hub.service`.

```bash
bash tests/disaster-recovery/platform-systemd.sh \
  /path/to/extracted/search-hub-linux-x64 /path/to/packaged/shub \
  /path/to/search-hub-v0.1.15-linux-x64.tar.gz \
  artifacts/disaster-recovery/platform-systemd
```

`platform-systemd.sh` starts the source unit, seeds synthetic state, stops it, runs packaged CLI create/verify/default dry-run/apply with `--start-check`, starts the restored unit, checks health/login/provider/key-decrypt/search/MCP, and refuses repeated restore. It then installs a newer package that never becomes healthy, requires updater exit 3, starts the old unit again, rechecks key decryption, verifies no stale WAL/SHM, and runs `updater-test.mjs`, `updater-faults.mjs` and the real v0.1.14→v0.1.15 `upgrade-matrix.mjs`. It writes `report.json` and `SHA256SUMS`.

The direct updater invocation proves the transaction and exit-3 rollback. A10's independent updater identity still requires a dedicated updater oneshot unit/user with narrowly scoped systemd permissions; until that run exists, A10 remains `NOT TESTED`, not PASS.

## Layers

| Layer | Location | Proves | Does not prove |
|---|---|---|---|
| Unit | `tests/unit` | Scheduling math, dedupe, RRF, URL canonicalization, SSRF rules, crypto, provider/model mapping | Real vendor behaviour |
| Integration | `tests/integration` | Real Fastify app + real SQLite + real HTTP routes, auth, persistence, MCP | External networks |
| Concurrency | `tests/integration/concurrency.test.ts` | 100 simultaneous searches never exceed per-key limits; counters return to zero | Multi-process coordination |
| E2E | `tests/e2e` | First-run, login, providers, lab, theme, settings, integrations in a browser | Provider latency at scale |
| Smoke | `tests/scripts/smoke.sh` | Live process: setup → providers → keys → search → fault isolation → token → MCP | Anything requiring real vendor keys |

## What is covered

v0.1.13 历史本地全量已通过 Vitest **1299 项 / 100 文件**、Playwright **42 项**与 CLI 专项 **58 项**。本文件不把本地结果写成远端 CI 或正式发布 PASS；远端证据见 `docs/release-readiness.md`。批量、资格判定、原子取消、预算/迁移、异常路径与 P09 验收均有定向覆盖；真实 HTTP 路径使用 `127.0.0.1` 服务，不调用第三方厂商。

v0.1.14 增加资源端点、只读认证、队列生命周期、严格进程枚举、OOM 证据、资源证据 fingerprint 与 exact-SHA release gate 测试。M04 是 P0 实测门槛：100,000 行、100 warmup、1,000 次顺序 `GET /api/admin/resources`，P95 ≤ 10ms、稳态 RSS ≤ 2MiB、warmup/正式零写、三个 query plan 均走索引。`pnpm evidence:verify` 校验 8 份 gzip raw、summary、SHA256SUMS、代码/scope fingerprint 与公开证据脱敏；未满足条件的证据保持 BLOCKED。

### v0.1.17 onboarding and provider reliability

The v0.1.17 targeted suites separate browser/control-flow proof from real public-network evidence:

| Area | Files | What it proves |
|---|---|---|
| First-run onboarding | `tests/integration/onboarding.test.ts` (9 cases), `tests/e2e/onboarding.spec.ts` (3 cases) | Fresh setup lands on the three-step guide; only recommended built-in keyless `live_tested` raw-search sources are suggested; a ready vertical/test source advances the provider step while `coverage.generalWebReady=false` is reported explicitly; completion requires a caller-owned completed/partial search task with at least one result or verifiable citation; empty searches and evidence-free completion are rejected; dismiss clears completion; anonymous and non-admin callers are rejected; legacy settings remain readable. |
| Public-provider rate limits | `tests/unit/provider-rate-limit.test.ts` (7 cases) | arXiv keeps a 3-second minimum interval and one in-flight request; Wikipedia sends a compliant User-Agent and enforces 60/minute with two in flight; GitHub keyless keeps 10/minute, 60/hour and one in flight; GitHub code search without a token fails before any request. |
| Public-provider response contracts | `tests/unit/provider-public-contract.test.ts` (28 cases) | Legal empty results stay empty; HTTP 200 business errors and incompatible envelopes fail; 429 preserves `Retry-After`; 408/504 map to `timeout`; mapping/deduplication stays stable; Brave uses upstream raw row count for pagination; arXiv URLs are normalized to HTTPS. |
| Grounded-answer probe safety | `tests/integration/health.test.ts` | A grounded provider rejects a free `connect` probe before invoking a paid model; a search probe with a verifiable citation counts as success. Runtime health still does not upgrade implementation verification. |
| Live evidence schema | `tests/unit/doc-consistency.test.ts`, `scripts/check-doc-consistency.mjs` | Evidence must identify the provider, `schemaVersion: 2`, exact 40-character source commit, adapter version, successful request URL/status/result count/sample URLs/latency/recorder, latest attempt and attempt history. |

Reproduce the deterministic suites without vendor credentials:

```bash
pnpm exec vitest run tests/integration/onboarding.test.ts \
  tests/unit/provider-rate-limit.test.ts tests/unit/provider-public-contract.test.ts \
  tests/integration/health.test.ts tests/unit/doc-consistency.test.ts
pnpm build && pnpm exec playwright test tests/e2e/onboarding.spec.ts
```

Real keyless checks are a separate, budgeted network activity. On 2026-11-27 the live harness recorded two successful queries each for Wikipedia, arXiv and GitHub, with five HTTPS results per query and no paid API key. Together with the existing Hacker News, Crossref, OpenAlex and PubMed evidence, the catalogue has seven `live_tested` entries. The other entries remain `documented`, `mock_verified` or otherwise unverified; a local stub run never changes that status.

### v0.1.11 bulk provider test (T01–T46, H61–H66)

Every one of the 45 acceptance cases maps to one file and one executable
assertion. Nothing is stubbed at the HTTP layer: a "probe" either reaches a
`http.createServer` on 127.0.0.1 or is injected through `app.inject` against a
real SQLite database. **No real vendor is contacted.**

| T | File | Case name | Key assertion |
|---|---|---|---|
| T01 | `tests/integration/provider-single-test.test.ts` | `T01 only HealthService.checkOne builds a probe config` | exactly one `provider_health_checks` row after `:id/test`; `rg "adapter.search\(" apps/api/src/routes` = 0 hits (scanned in the test) |
| T02 | same | `T02 a paginated source test issues more than one upstream request` | Brave stub + `searchConfig{targetResults:50,maxPages:3}`: `stub.hits() >= 2`, `body.requests >= 2`, `detail_json.requests >= 2` |
| T03 | same | `T03 single test equals checkOne for the same source` | `:id/test` and `checkOne` agree on `resultCount`, `cause` and request count |
| T04 | same | `T04 keeps the legacy fields, adds the conclusion fields and leaks no key` | 5 legacy fields keep their types; 7 new fields present; no plaintext, no ciphertext in the body |
| T05 | `tests/integration/provider-batch-preview.test.ts` | `T05 reports 12 testable / 5 without key / 3 disabled for 20 sources` | paid off → `eligible=0`, `coolingSkipped=12`, `estimatedPaidProbes=12`; paid on → `eligible=12`, `paidRisk=true` |
| T06 | same | `T06 connect preview ignores the paid budget and never claims paid risk` | `kind=connect` → `paidRisk=false`, `estimatedPaidProbes=0`, `coolingSkipped=0`; paid search with switch off → `eligible=0`, `coolingSkipped=1` |
| T07 | same | `T07 paid probes disabled blocks a search run with 409` / `T07 an exhausted daily budget blocks a paid run before anything is spent` | 409 `validation_error`; no job row, no health row written |
| T08 | same | `T08 a preview writes neither health rows nor job rows` | row counts identical before/after both kinds |
| T09 | same + `tests/unit/provider-eligibility.test.ts` | `T09 the seven counters sum to total for a mixed scope` / `counts sum to total, whatever the mix of reasons` | 7 buckets sum to `total`, including cooldown + keyless-policy |
| T10 | `tests/integration/provider-batch-run.test.ts` | `T10 create returns a jobId, running status and the concurrency in use` | 201, `status=running`, DB row matches, `nextPollAfterMs=1000` |
| T11 | same | `T11 finished items are readable while the run is still running` | `status=running` **and** a row with `state=ok` + `checkId`, whose health row has `batch_id` |
| T12 | same | `T12 counts are monotonic and never exceed the total` | 5 polls: `done` never decreases, `done+skipped<=total` |
| T13 | same | `T13 cancel keeps finished items readable and marks the rest cancelled` | `status=cancelled`; finished rows keep the same `checkId`; remainder `SKIPPED_CANCELLED` with `checkId=null` |
| T14 | same | `T14 a restart marks the run interrupted and never completed` | second context on the same `dbPath` → `interrupted`, `remaining=0`, unknown items become `SKIPPED_INTERRUPTED`, counters satisfy the identity |
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
| T29 | same | `T29 可选 Key 不被匿名探测使用，样例最多 3 条且 requests 缺失显示 —` | optional key pool is not used, key label is `—`, ≤ 3 samples, `requests` renders `—`, no key material anywhere |
| T30 | same + `tests/unit/i18n-parity.test.ts` + `tests/unit/provider-batch-view.test.ts` | `T30 英文界面下批量体检文案无硬编码中文` / parity / message coverage | `zh`/`en` key sets equal, no CJK in the dialog in English, every classification has a label and an advice sentence in both locales |
| T31 | `tests/e2e/provider-batch.spec.ts` | `T31 页面顶部「全部测试」打开同一个预检框` | the page-header entry opens the **same** pre-flight dialog (same count rows, same scope line); closing it leaves no dialog behind |
| T32 | same | `T32 刷新后提示条出现并能打开上次检测结果` | a real run → reload → the notice describes the server's status → opening it shows the result table from the *same* job id |
| T33 | same | `T33 任务不存在时静默清除，不显示提示条也不报错` | a pointer to a job the server does not have produces no notice, no error alert, and is dropped from `localStorage` |
| T34 | same | `T34 结果表 8 列，1600×1000 下操作列完整可见且无横向溢出` | exactly eight `<th>`; no `batch-requests-*` cell; `scrollWidth <= clientWidth`; both row actions inside the dialog box; a row retest opens the single-source dialog and leaves the batch row untouched |
| T35 | `tests/e2e/provider-single-test.spec.ts` | `T35 单源测试通过：结论、结果数、测试时间与脱敏 Key，页面无 Key 明文` | Brave-shaped loopback stub: `返回结果=3`, measured `requests=stub.hits()`, truncated key id, no plaintext, health `healthy` after reload |
| T36 | same | `T36 单源测试的上游请求数是真实测量，并写回健康概览` | a loopback HN stub: `requests` equals what the stub's socket counted, results = stub's rows, health flips to `healthy` |
| T37 | same | `T37 单源测试失败：显示鉴权分类与建议，而不是笼统失败` | a real 401 from a loopback stub → "测试失败" + `Key 无效或已过期` + advice; health shows `invalid_credentials` |
| T38 | same | `T38 单源测试后无需整页刷新，切健康 tab 立即看到新状态` | after a successful test, switching tabs shows the new state without `page.reload()` |
| T39 | `tests/e2e/provider-batch-regression.spec.ts` | `T39 连点「开始检测」只创建一个任务，请求飞行中按钮禁用` | one POST while the button is disabled; one job id polled; rows = scope size exactly once; counts describe three successes, not six |
| T40 | same | `T40 混合五类来源：八列表格分组与计数一致、分类只在抽屉` | five groups present, `counts.failed` includes the restricted row, skips counted in neither, classification only in the drawer |
| T41 | same | `T41 无 Key 来源：预检可见、开始仍可点，结果记为跳过而不是失败` | `count-nokey > 0`, the start button still enabled while other sources are testable, those rows end `skipped` |
| T42 | same | `T42 免 Key 开关：关闭后免 Key 来源跳过而不是失败，请求数只在抽屉` | with the toggle off, keyless rows are `skipped`; the table has no `batch-requests-*` cell |
| T43 | same | `T43 取消后「只重测失败项」不包含被取消的来源` | the retry body excludes cancelled ids (it is the `failedIds` set) |
| T44 | same | `T44 刷新恢复遇他人任务（403）：不显示提示条、不报错、指针被清除` | a 403 for the remembered job yields no notice, no alert, no dialog, and clears the pointer; cross-account 403 itself is covered by `provider-batch-owner.test.ts` |
| T45 | `tests/integration/provider-batch-preview.test.ts` | `T45 task-level includeKeyless defaults false and does not write global settings` | preview/start read the request snapshot; global `includeUnverified` stays unchanged; a policy skip writes no health row |
| T46 | `tests/e2e/provider-batch-regression.spec.ts` | `T46 取消后必须轮询到 remaining=0 才停止并展示结果` | two consecutive cancelled snapshots with `remaining>0` do not stop polling; only the settled response opens results |
| H61–H66 | `tests/integration/health.test.ts` + `tests/integration/provider-batch-cancel-race.test.ts` | zero-wire accounting, cross-midnight refund, atomic cancellation and failure-path safety | real SQLite + synchronous gates/triggers; one winner among 100 cancels; crash rollback, restart, stale-runner overwrite, billing/schedule/reservation failures and undecryptable overview are covered without fixed sleeps |

The E2E suite seeds only the built-in `mock` adapter and `http.createServer`
stubs on 127.0.0.1; `paidProbesEnabled` is switched on only for cases that need a
credentialed Brave path, which is safe precisely because no vendor is reachable.

### v0.1.13 CLI (C01–C50)

The CLI suite spawns the real TypeScript entrypoint and uses loopback HTTP/TLS
servers. It never calls a paid vendor.

| Area | Evidence |
|---|---|
| C01–C10 | help/version, normal/Chinese/Unicode search, provider/group/options, deep route, partial and failed responses |
| C11–C16 | JSON-only stdout, jq on Linux, PowerShell `ConvertFrom-Json` on Windows, complete errors/failedSources, strict partial, honest NDJSON |
| C17–C24 | token redaction, no plaintext token config, 401/403 mapping, cross-origin redirect refusal, remote HTTP rejection, self-signed TLS rejection, no shell invocation, stdin token |
| C25–C35 | single probe, missing/disabled key skips, keyless opt-in, cost confirmation, admin scope, batch polling/cancel, budget refusal, no retry on `already_running` |
| C36–C43 | unreachable, DNS, TLS, 429 `Retry-After`, 503, timeout, Ctrl+C, no billable POST retry |
| C44–C47 | real Windows/Linux x64/Linux arm64 SEA acceptance plus Node 22 portable package; each connects to a real Search Hub server and performs REST search |
| C48–C50 | v0.1.12 server compatibility, unchanged REST/MCP/Skills gates, release checksum/provenance verification |

### v0.1.12 credential redaction, probe locking and connect budgets

These suites pin the release's security and accounting contracts against real
Fastify routes, real SQLite and loopback HTTP servers. They do not call vendors.

| File | What it proves |
|---|---|
| `tests/integration/provider-query-key-redaction.test.ts` | Query API keys do not leak through JSON 401/403/429/500 errors, HTML error pages, literal/URI/lowercase-percent/form/double-encoded echoes, a 200 error envelope, custom generic-http query injection, error `details.url`, SQLite health history, Key `last_error_message` or audit detail. Error classification and actual upstream requests are preserved. |
| `tests/integration/provider-query-key-surfaces.test.ts` | REST and MCP search failures, Firecrawl HTTP 200 envelopes, mixed encoding, an 8192-character credential, task/event/Key persistence and provider-failure logs remain classified and credential-free. |
| `tests/integration/provider-historical-redaction.test.ts` | Pre-v0.1.12 diagnostics are withheld on every read surface without rewriting the original audit rows, including after credential rotation/deletion. |
| `tests/integration/health-connect-budget.test.ts` | Connect probes reserve one unit per physical hop, pagination/redirects stop at the local cap, the refusal is 429 `quota_exceeded` with no health/billing row and no Key failure, the daily cap survives reopen, batch work records `SKIPPED_BUDGET`, and `billingUnit` is `unknown`. One hundred concurrent `checkOne` calls yield one hop and 99 `already_running` refusals. |
| `tests/integration/health-probe-lock.test.ts` | Single-source, bulk, Key and scheduled paths cannot probe one provider concurrently; duplicates return/record `already_running` and do not double-spend. |
| `tests/integration/provider-preview-readonly.test.ts` | Batch preview, overview, settings GET and MCP health leave complete rows (including `api_keys` and `updated_at`) unchanged, even with dirty scheduler state; UTC rollover/cooldown recovery is evaluated on copies; old budget snapshots are normalized; a missing ledger is computed without materializing it. |
| `tests/unit/connect-budget-migration.test.ts` | Migration 0010 archives the old connect ledger, conservatively counts missing/zero/invalid request counts as one hop, never lowers a counter, inserts missing recomputed days and is idempotent. Migration 0011 adds sanitized markers defaulting to false without changing legacy bytes. |

Key create/update schemas require at least 8 trimmed characters. The candidate
Vitest total above includes these fixes but remains subject to the release
owner's final full-suite verification.

### Key safety and billing classification (H46–H62)

| H | File | Case | Key assertion |
|---|---|---|---|
| H46 | `tests/integration/provider-key-safety.test.ts` | 401 invalidates a key; a later real success restores it | invalid is distinct from transport failure; manual success clears it |
| H47 | same + `tests/unit/key-scheduler-state.test.ts` | 403/blocked/auth_invalid-wrapper carrying 403 | `forbidden`, never `invalid`; account group is parked |
| H48 | `tests/integration/provider-key-safety.test.ts` | 429 rate limit | vendor cooldown is honoured and the key can recover |
| H49 | same + unit | quota exhaustion | key and account park until the next UTC midnight |
| H50 | same + unit | one 500 vs timeout/network/DNS/TLS | breaker threshold applies; transport errors never invalidate a credential |
| H51 | `tests/integration/provider-key-safety.test.ts` | empty results | credential validity is unchanged |
| H52 | same | cross-provider `keyId` | rejected before health, budget or upstream work |
| H53 | same | disabled/missing/undecryptable explicit key | no request, health row or budget spend |
| H54 | same + unit | scheduler availability, shared account quota, concurrency, `notSent`, generic templates, optional-key anonymity | automatic selection and health use the same facts; zero-request outcomes release slots; keyless stays anonymous |
| H55 | `tests/unit/health-budget-classification.test.ts` | seed from billing class | current provider type cannot rewrite historical paid/anonymous class |
| H56 | same | anonymous cap with paid probing off | independent anonymous day cap still applies |
| H57 | same | concurrent anonymous reservations | conditional updates cannot overshoot the cap |
| H58 | same | database reopen | neither search bucket resets |
| H59 | same | UTC midnight | both buckets switch on UTC, not local, midnight |
| H60 | `tests/integration/health-budget-classification.test.ts` | mixed v0.1.10→v0.1.11 history | legacy searches are conservative paid; only exact anonymous rows seed anonymous |
| H61 | `tests/integration/health.test.ts` + unit | zero physical requests | paid/anonymous reservation is released on its original `budgetDay`; non-spending rows never seed a bucket |
| H62 | `tests/integration/health-budget-classification.test.ts` | one-shot recompute | only billing rows with `spent=true` count |

**Bulk test data path** — `tests/unit/batch-migration.test.ts` (0008 cases plus the 0009 billing migration):
migration `0008` keeps v0.1.9 health rows with `batch_id NULL`, creates the
ledger with the defaults the runner relies on, adds both indexes, and applies
twice without error.

**Eligibility decisions** — `tests/unit/provider-eligibility.test.ts` (15 cases):
the 20/12/5/3 scenario against real rows, counter partition, decision order,
decrypt failure without leakage, paid/anonymous budget separation, explicit
invalid/quota/account-quota/cooldown skips, and generic `keyInjection` detection.

**Task-level policy** — `tests/integration/provider-batch-policy.test.ts` (10 cases):
default-off keyless behavior, immutable option snapshot, anonymous-only and mixed
paid-disabled runs, independent anonymous caps, optional-key anonymity, generic
credential detection and unavailable-key skips.

**Result-table classification** — `tests/unit/provider-batch-view.test.ts`
(11 cases): restricted vs failed, severity ordering with `null` latency last, the
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

- The catalogue and every adapter agree on which sources take a key: public
  entries declare `authType: none` and `requiresKey: false`, and `brave` /
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

**Never** treat a green mock-backed suite as evidence that a real vendor integration works. Hacker News, Crossref, OpenAlex, PubMed, Wikipedia, arXiv and GitHub have recorded live runs; the other adapters do not.

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

Local documentation gates are `pnpm check:docs` and `pnpm check:matrix`; they
validate README/catalog/version consistency and the generated provider matrix.
They are not substitutes for the full test suite or remote CI.

`.github/workflows/upgrade.yml` builds the current package on Windows and Linux
and upgrades published packages in place. The v0.1.13 PR and main runs
passed on both runners: [PR run 44997781914](https://github.com/alicia1030su/search-hub/actions/runs/44997781914)
and [main run 44998417741](https://github.com/alicia1030su/search-hub/actions/runs/44998417741).
The v0.1.14 candidate run [45133912965](https://github.com/alicia1030su/search-hub/actions/runs/45133912965)
also passed on both runners, including the new v0.1.13→current path with
`appliedDiff=[]` recorded from the `_migrations` table on each platform.
The matrix covers v0.1.4-beta.6, v0.1.5-beta.1, v0.1.7-beta.3, v0.1.8,
v0.1.10, v0.1.11, v0.1.12, v0.1.13 and v0.1.8-beta.1. Cache evidence is fail-closed:
persistent-cache versions must reuse the old row when the fingerprint is unchanged;
legacy memory-only versions must establish a new persistent row and prove a real
cache hit after warmup. Missing or ambiguous evidence fails the upgrade.

`.github/workflows/docker.yml` runs the container acceptance: image build with layer
cache, `docker compose config`, the 10-item `scripts/docker-verify.sh`
(live search, restart, persistence, resource footprint, crash recovery), and a
trivy HIGH/CRITICAL gate. It is a separate workflow so a container failure is never
confused with a host-tree failure. Details: [`docker-verification.md`](./docker-verification.md).

If a job cannot run in your environment (for example no Docker daemon), say so in the PR instead of marking it passed.
