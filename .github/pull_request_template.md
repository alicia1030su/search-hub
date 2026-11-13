# Pull request

## What changed

<!-- One paragraph. Link the issue if there is one. -->

## Type

- [ ] Bug fix
- [ ] Security hardening
- [ ] New provider adapter
- [ ] Docs / CI / release
- [ ] Refactor (no behavior change)

## Verification

Every PR must state **exactly** what was run and what happened.

| Command | Exit code | Result |
|---|---|---|
| `corepack pnpm typecheck` | | |
| `corepack pnpm lint` | | |
| `corepack pnpm test` | | |
| `corepack pnpm build` | | |
| provider live check (if applicable) | | |

## Provider changes (if any)

| Item | Value |
|---|---|
| Provider type | |
| Official docs | |
| Verification level after this PR | `documented` / `live_tested` |
| Evidence for `live_tested` | <!-- command + result URL + date, no key --> |

A green mock suite alone must not promote a provider to `live_tested`.

## Security checklist

- [ ] No API keys, tokens, cookies, proxy credentials, or internal hostnames in the diff.
- [ ] Outbound requests still go through `ctx.fetch` (SafeFetch); no raw `fetch`/`axios`/`node:https`.
- [ ] New config has a safe default and is documented.
- [ ] If proxy behavior changed: I ran the proxy SSRF tests and confirm blocked targets never reach the proxy.
- [ ] Error paths return an explicit error code, not an empty result.

## Docs

- [ ] User-facing behavior change is reflected in `README.md` / `docs/*`.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] Any claim of "supported" is backed by a linked test or recorded live run.

## Notes for reviewers

<!-- Trade-offs, rejected alternatives, known gaps, follow-ups. -->
