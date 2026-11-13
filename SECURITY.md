# Security Policy

Search Hub stores API credentials for third-party services and can reach arbitrary URLs on the operator's behalf. Treat a deployed instance as a sensitive system.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

- Use GitHub's private vulnerability reporting on the repository ("Security" → "Report a vulnerability").
- Or email the maintainers listed in `SECURITY.md`'s maintainer block with: affected version, reproduction steps, impact, and whether you need credit.

We aim to acknowledge within 3 working days and to ship a fix or mitigation within 30 days for high-severity issues. Please give us that window before public disclosure.

## Scope

In scope:

- Authentication and authorisation bypass (session, CSRF, token scope, MCP endpoint).
- Secret disclosure: API keys, access tokens, master key, password hashes, session cookies — through API responses, logs, exports, error messages, or the database.
- SSRF: reaching loopback, private networks, cloud metadata, or bypassing the destination allowlist (including DNS rebinding and redirect chains).
- Injection: SQL injection, template/path injection in the declarative provider mapping, prompt injection that escapes the untrusted-content boundary.
- Denial of service that persists after restart or corrupts stored configuration.

Out of scope:

- Vulnerabilities in upstream search providers or model vendors.
- Findings that require an already-compromised host or a leaked `SEARCH_HUB_ENCRYPTION_KEY`.
- Rate limits being hit (that is intended behaviour; see below).

## Security model

**Authentication.**

- The first-run page creates the only administrator. There is no default account or default password.
- Passwords are stored as `scrypt$N$r$p$salt$hash` (N=16384, r=8, p=1) with a per-user salt.
- Admin sessions are opaque 32-byte tokens; only their SHA-256 hash is stored. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `SEARCH_HUB_COOKIE_SECURE=true`.
- Every state-changing admin request must carry `x-csrf-token` matching the session's CSRF value. A missing header is a 403, not a silent success.
- External integrations use bearer tokens (`sh_...`), stored as SHA-256 hashes, with scopes (`search`, `sources:read`, `mcp:use`, `admin`), an optional expiry, and a per-token per-minute limit. Tokens are shown once at creation.
- **First-run initialisation always requires a one-time token.** When `SEARCH_HUB_SETUP_TOKEN` is set, that value is used; otherwise the server generates `<data>/setup-token` (mode `0600`), prints it once, and deletes it after setup. Administrator creation runs inside a `BEGIN IMMEDIATE` transaction with a second count check, so concurrent setup requests cannot create two administrators.
- **Host header validation.** Every route except `/api/health` rejects requests whose `Host` is neither an IP literal, `localhost`, the `SEARCH_HUB_PUBLIC_URL` hostname, nor an entry in `SEARCH_HUB_ALLOWED_HOSTS`. This blocks DNS rebinding before authentication. `/mcp` additionally validates `Origin` when present.

**Secrets at rest.**

- Provider and model API keys are encrypted with AES-256-GCM using a 32-byte master key from `SEARCH_HUB_ENCRYPTION_KEY` or `data/master.key` (generated on first start, mode `0600`).
- The API never returns plaintext keys: list responses contain a mask (`…abcd`) derived from the last four characters.
- Config export contains key **labels** only.
- The structured logger redacts `authorization`, `cookie`, `apiKey`, `api_key`, `password`, `token`, `key`, and `csrfToken`.

**Backup consequence.** `data/master.key` is required to decrypt stored keys. If you lose it, stored credentials cannot be recovered — they must be re-entered. Back up the database and the master key together, and keep them separate from public backups.

**Outbound requests (SSRF).**

Every provider/model call goes through `createSafeFetch` in `packages/shared`:

1. URL scheme and credential checks; plain HTTP is configurable but on by default so self-hosted SearXNG works.
2. DNS resolution, then classification against IPv4/IPv6 blocklists (loopback, RFC1918, CGNAT, link-local, multicast, documentation ranges, IPv6 ULA/link-local, IPv4-mapped IPv6).
3. Cloud metadata addresses (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) are **always** rejected, even if allowlisted.
4. Redirects are followed manually (max 3) and the destination is re-validated at each hop.
5. The actual connection uses an undici `Agent` with a custom `lookup` that filters blocked addresses again at connect time, which defeats DNS rebinding between resolution and connection.
6. Response size is capped (4 MiB default) and read with a timeout.

To reach an intentional internal service (self-hosted LLM, internal SearXNG), add it to **Settings → Security → private host allowlist**. Patterns support exact hosts, `.suffix`, and `*.suffix`. Allowlisting never bypasses the metadata blocklist.

**Untrusted content.**

Search snippets are attacker-controlled text. When summarising:

- Retrieved text is wrapped in `<untrusted_search_results>` and any embedded copy of that marker is stripped from the payload.
- The system prompt instructs the model to ignore instructions inside the block and to answer only from the provided material.
- `detectPromptInjection()` flags common patterns (`ignore previous instructions`, `system:`, role tags, `im_start`/`im_end`, tool-call syntax) so the UI and logs can surface them.
- The model has no tool access and never sees provider API keys.

**Content security.**

In production the API sends `Content-Security-Policy` (`default-src 'self'`, no inline scripts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Opener-Policy: same-origin`.

## Rate limiting and quota behaviour

Rate limiting is a **safety** feature, not a bug:

- Per-key concurrency, per-minute requests, and daily quota are enforced before a request is dispatched.
- `429` responses put the key into cooldown for `Retry-After` (bounded to 1 hour); `401`/`403` suspend the key until an operator re-tests it; 5xx/timeouts back off exponentially and trip a per-provider circuit breaker.
- When no key can serve a request, the API returns `503` with `no_available_key` — it does not silently return an empty result set.

## Known residual risks

| Risk | Impact | Mitigation / status |
|---|---|---|
| Process crash loses the in-memory rate window | Up to 60 s of per-key RPM and in-flight counts may be understated after `kill -9`; the next start recalibrates from today's `search_events` | Accepted limitation, documented; graceful `SIGTERM` flushes counters |
| Single-node only | Two instances against one database would each enforce their own limits | Not supported; Redis-backed coordination is not implemented |
| Allowlisted internal hosts | An allowlisted host can be used to probe that host's services | Operator-controlled, audited on change |
| Model output can be wrong | Summaries may be inaccurate even with citations | Every summary carries `[n]` citations to real result URLs; `degraded: true` on model failure |
| Snippet-level injection | A malicious page may try to steer the summary | Boundary marker + system guard + pattern detection; not a guarantee, treat summaries as advisory |

## Hardening checklist for operators

- [ ] Set a fixed `SEARCH_HUB_ENCRYPTION_KEY` and back it up.
- [ ] Serve over HTTPS via a reverse proxy; set `SEARCH_HUB_COOKIE_SECURE=true` and `SEARCH_HUB_TRUST_PROXY=true` (loopback-only) or an explicit proxy CIDR such as `172.17.0.0/16`.
- [ ] Set `SEARCH_HUB_PUBLIC_URL` and, if you use additional hostnames, `SEARCH_HUB_ALLOWED_HOSTS`.
- [ ] Set `SEARCH_HUB_SETUP_TOKEN` before exposing the instance publicly, or read the generated token from the log/file and keep it private.
- [ ] Do not expose port 8787 directly to the internet.
- [ ] Create one token per integration with the narrowest scope; revoke unused tokens.
- [ ] Review `/api/admin/audit` periodically for unexpected admin actions.
- [ ] Keep the private host allowlist empty unless you truly need internal destinations.
- [ ] Run `pnpm audit` after dependency updates.

## Maintainers

Security contact: the maintainers listed in the repository's `CODEOWNERS` / GitHub organisation profile. Replace this line with a monitored address before publishing a release.
