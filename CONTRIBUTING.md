# Contributing

Thanks for helping. This project values **honest capability claims** over surface area: a provider marked “supported” must actually work, and an untested integration must say so.

## Ground rules

1. **No fabricated results.** Do not add a provider, endpoint, or model adapter based on guesswork. Link the official documentation you implemented against.
2. **No fake tests.** Do not weaken an assertion to make CI pass, and do not mock away the behaviour under test.
3. **No silent degradation.** A failed upstream must produce an error code, not an empty success.
4. **Secrets never enter git.** No API keys, tokens, cookies, or personal data. Use `.env` (git-ignored) and the local mock providers.
5. **One search core.** REST, MCP, and Skills must call the same engine. A second implementation will be rejected.
6. **Preserve user data.** Migrations must be additive; never drop stored keys.

## Development setup

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev          # API + Vite dev server
corepack pnpm test         # unit + integration
corepack pnpm typecheck
corepack pnpm lint
```

Node ≥ 22.12, pnpm 12. SQLite is created under `data/`.

Useful environment variables for local work:

```bash
SEARCH_HUB_DATA_DIR=./.data/dev
SEARCH_HUB_PORT=8787
SEARCH_HUB_LOG_LEVEL=debug
```

## Repository layout

| Path | Responsibility |
|---|---|
| `packages/shared` | Types, Zod schemas, URL canonicalization, SSRF-safe fetch. No business logic. |
| `packages/core` | Scheduler, fan-out, fusion, error classification. Must not import providers. |
| `packages/providers` | One file per adapter + catalog. Must not import `core`. |
| `packages/models` | Chat / embedding / rerank adapters and prompt pipeline. |
| `packages/db` | Drizzle schema and SQL migrations. |
| `apps/api` | Fastify routes, auth, services, MCP mount. |
| `apps/web` | React admin UI. |
| `packages/mcp` | MCP server factory, tools, stdio proxy. |

Dependency direction: `shared ← core / providers / models / db ← api`. No cycles.

## Adding a search provider

1. **Research first.** Open an issue with the official documentation URL, auth mechanism, request shape, response shape, rate limits, and error semantics. If there is no publicly verifiable API, add a catalog entry with `implementation: "planned"` or `"unavailable"` instead of an adapter.
2. Add the catalog entry in `packages/providers/src/catalog.ts`:
   - `implementation`: `builtin` only if you ship the adapter.
   - `verification`: `documented` unless you have a recorded live run; `live_tested` requires evidence in the PR description.
3. Implement `SearchProviderAdapter` in `packages/providers/src/builtin/<name>.ts`:
   - Use `callJson` from `../http.js` so SSRF protection, timeouts, and size caps apply.
   - Map HTTP status to `ProviderError` codes: 401/403 → `auth_invalid`, 429 → `rate_limited` (carry `retryAfterMs`), 402 → `quota_exceeded`, 408/504 → `timeout`, 5xx → `server_error`.
   - Never invent a title, URL, or date. Drop results that lack a title or a valid http(s) URL.
4. Register it in `packages/providers/src/registry.ts`.
5. Add the default base URL to the catalog **only** if it is documented.
6. Tests (`tests/unit/providers.test.ts`):
   - Happy path against a local HTTP fixture.
   - 401, 429 (with `Retry-After`), 5xx.
   - Malformed payload.
   - Missing key.
7. Update `README.md`, `README_EN.md`, and `docs/providers.md` — including “not live-tested” when true.

## Adding a model adapter

- Implement the provider-neutral interface in `packages/models`.
- Validate embedding dimensions against the configured value; reject mismatches.
- Treat every retrieved snippet as untrusted input; never let it alter system instructions.
- Add tests with a local HTTP server; do not call a paid vendor in CI.

## Database changes

- Add a new `packages/db/migrations/000N_*.sql`; never edit an applied migration.
- Keep it additive and idempotent where SQLite allows (`IF NOT EXISTS`).
- Update `packages/db/src/schema.ts` to match.
- Add an integration test that opens a fresh database and applies all migrations.
- Test upgrade from the previous schema with existing provider/key rows.

## Frontend changes

- All data must come from the real API; no hard-coded demo rows.
- Every button must do something or be hidden/disabled with an explanation.
- Support light and dark themes; keep Chinese as the default locale.
- Run `pnpm --filter @search-hub/web typecheck` and `build`.

## Security-sensitive changes

Changes touching auth, crypto, SSRF, MCP transport, or prompt construction need:

- A short threat note in the PR (what can go wrong, what blocks it).
- Tests for the negative path, not only the happy path.
- A `SECURITY.md` update if the residual risk changes.

## Commit and PR

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- One logical change per PR; include the commands you ran and their output.
- State explicitly what was **not** verified (for example: “Brave adapter tested against a local fixture only; no live key”).
- Do not commit `data/`, `.env`, build output, or test traces.

## Release process

Maintainers only:

1. Update `CHANGELOG.md` and the version in `package.json` files.
2. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`.
3. Build and run the container on a clean host; complete the first-run flow.
4. Tag `vX.Y.Z` and publish release notes that separate **verified** from **unverified** capabilities.

No force-push, tag rewrite, or destructive migration without maintainer approval.
