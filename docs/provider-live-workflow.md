# Provider live verification (real credentials, separate from Docker acceptance)

This workflow exists so a **real** third-party search call can never be confused
with the keyless Docker acceptance. It has no `push` or `pull_request` trigger:
it only runs when a maintainer dispatches it, and it reads credentials from the
`provider-live` environment. The Docker workflow never receives a provider key.

## One-time setup (maintainer)

1. Repository → Settings → Environments → New environment → `provider-live`.
2. Add one or more environment secrets:
   - `TAVILY_API_KEY`
   - `BOCHA_API_KEY`
   - `BRAVE_API_KEY`
3. Optionally require a reviewer for the environment, so a secret-bearing job
   cannot start without approval.
4. Actions → Provider live verification → Run workflow → choose `auto` (default)
   or a single provider.

## What it proves

- `auto`: every provider whose secret exists is called with a Chinese query and
  an English query; missing secrets print `SKIP` and do **not** fail the run.
- A configured provider fails the job if the call returns no results, a
  non-`https` URL, an `example.com` URL, or a `401`.
- Keys are passed only through the step environment; the script never logs or
  writes them. No artifacts are uploaded.

## What it does not prove

- Search quality or ranking: there is no labelled ground truth.
- Multi-provider fusion: that requires a running instance and is covered by the
  keyless acceptance plus `tests/scripts/live-search.mjs`; do not claim it from
  this job.
- That the provider is `live_tested` in the catalog automatically. Update
  `catalog.ts` and `docs/provider-matrix.md` only after a green run, and paste
  the run URL into the provider notes.
