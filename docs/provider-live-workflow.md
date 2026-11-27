# Provider live verification (real network, separate from Docker acceptance)

This workflow exists so a **real** third-party search call can never be confused
with the keyless Docker acceptance. It has no `push` or `pull_request` trigger:
it only runs when a maintainer dispatches it. Credentialed providers read keys
from the `provider-live` environment; the Docker workflow never receives them.

## One-time setup (maintainer)

1. Repository → Settings → Environments → New environment → `provider-live`.
2. Optionally add one or more environment secrets:
   - `TAVILY_API_KEY`
   - `BOCHA_API_KEY`
   - `BRAVE_API_KEY`
3. Optionally require a reviewer for the environment, so a secret-bearing job
   cannot start without approval.
4. Actions → Provider live verification → Run workflow → choose `auto` (default)
   or a single provider.

`auto` always runs the keyless public providers (`wikipedia`, `arxiv`, `github`)
and runs each credentialed provider only when its secret exists. Missing secrets
print `SKIP`; they never become a pass. A run with no selected provider fails.

## What it proves

- The selected adapter was called against the real vendor endpoint.
- Every configured query returned a non-empty result set with HTTPS,
  non-placeholder URLs and no duplicate URLs.
- The script writes a redacted `evidence-<provider>.json` record containing the
  source commit, adapter version, request URL, HTTP status, result count, sample
  URLs, latency and per-query attempts.
- A configured provider fails the job if a call returns no results, a business
  error, an incompatible response shape, a non-HTTPS URL, or an `example.com`
  URL.

## What it does not prove

- Search quality or ranking: there is no labelled ground truth.
- Multi-provider fusion: that requires a running instance and is covered by the
  keyless acceptance plus `tests/scripts/live-search.mjs`; do not claim it from
  this job.
- That the provider is automatically `live_tested` in the catalog. Review the
  evidence record, copy it to `docs/live-evidence/<provider>.json`, then update
  `catalog.ts` and regenerate `docs/provider-matrix.md`.
- REST/MCP end-to-end compatibility: this job validates the adapter only.

## Credential and artifact safety

- Keys are passed only through the step environment; the script never logs or
  writes them.
- The script scrubs every printed line and evidence file. The workflow scrubs
  logs and evidence again before uploading them as a short-lived artifact.
- Evidence files must not contain tokens, cookies, authorization headers or
  private request data.
