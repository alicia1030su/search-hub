# Security Policy

Search Hub stores API credentials for third-party services and can reach arbitrary URLs on the operator's behalf. Treat a deployed instance as a sensitive system.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

- Use GitHub's private vulnerability reporting on this repository: <https://github.com/alicia1030su/search-hub/security/advisories/new>.
- Include the affected version, reproduction steps, impact, and whether you need credit.

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
- The API never returns plaintext keys: list responses contain a first-4 + last-4 mask (`sk-1…abcd`); values of 12 characters or fewer collapse to `••••`.
- Config export contains key **labels** only.
- The structured logger redacts `authorization`, `cookie`, `apiKey`, `api_key`, `password`, `token`, `key`, and `csrfToken`.

**Backup consequence.** `data/master.key` is required to decrypt stored keys. If you lose it, stored credentials cannot be recovered — they must be re-entered. Use the encrypted `.shbackup` recovery package, which contains a consistent database snapshot and the master key under age encryption; store its passphrase separately. A legacy `.db` download or a live `db + WAL + SHM` copy is not a complete recovery point.

**Outbound requests (SSRF).**

Every provider/model call goes through `createSafeFetch` in `packages/shared`:

1. URL scheme and credential checks; plain HTTP is configurable but on by default so self-hosted SearXNG works.
2. DNS resolution, then classification against IPv4/IPv6 blocklists (loopback, RFC1918, CGNAT, link-local, multicast, documentation ranges, IPv6 ULA/link-local, IPv4-mapped IPv6).
3. Cloud metadata addresses (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) are **always** rejected, even if allowlisted.
4. Redirects are followed manually (max 3) and the destination is re-validated at each hop.
5. The actual connection uses an undici `Agent` with a custom `lookup` that filters blocked addresses again at connect time, which defeats DNS rebinding between resolution and connection.
6. Response size is capped (4 MiB default) and read with a timeout.

To reach an intentional internal service (self-hosted LLM, internal SearXNG), add it to **Settings → Security → private host allowlist**. Patterns support exact hosts, `.suffix`, and `*.suffix`. Allowlisting never bypasses the metadata blocklist.

## Outbound network and proxy trust boundary

Search Hub can be deployed behind an HTTP forward proxy (corporate egress proxy, container sidecar, egress gateway). Proxy support is deliberately **fail-closed**, because a proxy moves the point where the destination is resolved — and that is exactly where SSRF protection lives.

**Configuration (deployment only).** The proxy is read from the environment, never from the settings table, so it cannot be changed from the admin UI, a settings export/import, or a database restore:

| Variable | Meaning |
|---|---|
| `SEARCH_HUB_PROXY` | Absolute `http://` or `https://` proxy URL. `socks://`, `socks5://`, `pac+http://`, `file://`, `data:` and `ftp://` are rejected at boot. |
| `SEARCH_HUB_NO_PROXY` | Comma/space separated bypass list, `NO_PROXY` semantics (see below). |
| `SEARCH_HUB_PROXY_TRUST` | `untrusted` (alias `application-only`) or `trusted-networks` (alias `egress-enforced`). Any other value fails boot. **No default.** |
| `SEARCH_HUB_PROXY_FROM_ENV` | `true` to also honour ambient `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`. Off by default: those variables are routinely inherited from a shell, CI runner or base image and would silently reroute every provider call through an endpoint nobody chose. Opting in still requires `SEARCH_HUB_PROXY_TRUST`; without it the process refuses to start rather than run with an undeclared proxy. |

The pre-release `SEARCH_HUB_OUTBOUND_PROXY` / `_NO_PROXY` / `_PROXY_TRUST` spellings are accepted as aliases of the three above, so a deployment that followed an earlier draft of these docs does not silently stay on a direct connection.

A malformed URL, an unsupported scheme or an unknown trust level throws at startup (`createContext`). The process does not start with a broken proxy configuration, and it never silently falls back to a direct connection.

**What the application can still check (both modes).** `validateOutboundUrl` runs before **every** request and after **every** redirect hop, regardless of whether the hop is proxied:

- Scheme restricted to `http(s)`; plain HTTP only when `security.allowHttp` is on; URLs carrying `user:pass@` rejected.
- DNS resolution plus CIDR classification: loopback (incl. `::1`, IPv4-mapped IPv6), RFC1918, CGNAT (`100.64.0.0/10`), link-local, multicast, documentation and reserved ranges, IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`), `0.0.0.0/8`, `240.0.0.0/4`.
- Cloud metadata (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) is rejected **unconditionally**, even if the host is on the private host allowlist.
- Internal hostnames (`localhost`, `*.localhost`, `*.local`, `metadata.google.internal`).
- Redirects are followed manually (max 3) and re-validated per hop.
- Direct connections additionally filter addresses inside the connect-time `lookup` guard, which defeats DNS rebinding between validation and connection (`ERR_SSRF_BLOCKED`).

**What the application can NOT check once a proxy is in the path.** With an HTTP `CONNECT` tunnel or a forwarded request the *proxy* resolves and dials the destination. The connect-time `lookup` guard never runs for the real target, so the application cannot prove which address the proxy actually reached. It only knows the URL it asked for, and any DNS answer it saw itself is irrelevant to what the proxy will resolve later.

**Therefore the trust boundary is explicit.**

- Every proxied request is forced through an HTTP `CONNECT host:port` tunnel, so the proxy always sees an exact host and port rather than an absolute-form request-target that could be interpreted differently from the `Host` header.
- `SEARCH_HUB_PROXY_TRUST=untrusted` (the value used whenever the variable is unset, too): the private host allowlist is **ignored for proxied hops**. Loopback, RFC1918, CGNAT, link-local, `.local`, `localhost` and metadata targets are refused in the validation step — the proxy never receives a `CONNECT` for them. The proxy's connect counter staying at zero is asserted in `tests/unit/proxy-ssrf.test.ts`.
- **But "no CONNECT to a private target" is not the whole story.** The check above only proves that a target the *application* classifies as private never reaches the proxy. It does not prove that a target the application classified as public is not resolved to a private address later, by the proxy. A cooperating or compromised proxy can accept `CONNECT rebind.public.test:80` and dial `127.0.0.1` itself; the application sees a validated public hostname and a 200 response from an internal service. `tests/unit/proxy-ssrf.test.ts` (`does not trust the CONNECT target alone`) pins this behaviour deliberately, so nobody mistakes the zero-CONNECT assertion for full coverage. In `untrusted` mode this residual risk is **accepted and documented**, not eliminated: the boundary is "the operator chooses a proxy they trust to resolve names, while the application refuses targets it can classify as internal". Deployments that cannot tolerate this must use a direct connection or declare `trusted-networks` against a proxy that enforces its own egress ACL.
- `SEARCH_HUB_PROXY_TRUST=trusted-networks`: an explicit operator declaration that **the proxy itself enforces egress control** (its own allowlist / ACL, no `CONNECT` to internal ranges, egress logging). Only then is the private host allowlist honoured for proxied hops. It is a declaration about your infrastructure, not a feature toggle: setting it against a permissive proxy re-opens every SSRF path the tests above close.
- **No default for `SEARCH_HUB_PROXY_TRUST`.** An unset value behaves as `untrusted`, but `describeOutboundPolicy()` reports `proxyTrustDeclared: false` plus a `residualRisk` line, and the boot log emits a warning. Health output therefore never *implies* a boundary the operator did not state.
- A proxy that cannot restrict destinations must **not** be used to "make networking work". If the deployment needs internal destinations, allowlist them explicitly or use the trusted-networks declaration — never disable validation.

The resolved state is printed at boot and exposed read-only: `/api/health` reports `outbound.mode` (`direct` | `proxy`) plus the trust level, and `GET /api/admin/outbound` (admin only) returns the redacted proxy endpoint, `NO_PROXY` entry count, whether the private host allowlist is being honoured, and the list of controls the proxy must provide.

**`NO_PROXY` semantics.** Entries are matched case-insensitively against the resolved request host:

| Entry | Matches |
|---|---|
| `*` | everything (proxy effectively disabled) |
| `example.com` | `example.com` and `api.example.com`, never `notexample.com` or `example.com.evil.test` |
| `.example.com` / `*.example.com` | the apex and all subdomains |
| `host:port`, `[::1]:8080` | that host **and** that port only |
| `10.0.0.0/8` | IP literals inside the CIDR (no DNS lookup is performed) |

A bypassed target goes back through the direct path and keeps the connect-time guard, so the private host allowlist still applies to it (that is how a self-hosted SearXNG stays reachable when the proxy is untrusted). Bypassing the proxy does **not** bypass validation.

**Credential handling.** Proxy credentials are accepted in the proxy URL but never printed: the display form is `scheme://host:port`, `Proxy-Authorization` is passed to undici as a separate token instead of being embedded in the agent URI, and the 407 / 502 / connection-refused error paths are mapped to stable codes (`blocked` / `network`, HTTP 502 to clients) whose message and `details` contain only the redacted proxy endpoint. Proxies must not log the `Proxy-Authorization` header they receive.

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
| Proxy trust declaration | With `proxyTrust=trusted-networks` the application accepts the proxy's guarantee; a permissive proxy re-opens internal reachability | Default is `untrusted` (private targets rejected regardless of allowlist); state is logged at boot and shown in `/api/admin/outbound` |
| Proxy DNS divergence | A malicious proxy can resolve a public hostname to an internal address; the application cannot detect it | Only a network-level control can prevent this — deploy a proxy that enforces egress ACLs, or keep `trusted-networks` unset |
| Build-time ReDoS with no upstream fix | GHSA-fc5q-39xc-vjpf / CVE-2026-112366: picomatch <= 4.0.7 is vulnerable, and no patched release exists. Not present at run time — every path is a devDependency of `@search-hub/web` or vitest, the runtime image installs with `pnpm install --prod`, and the shipped web bundle is static output | Accepted in `pnpm-workspace.yaml › auditConfig.ignoreGhsas` with the reasoning recorded there; `pnpm audit --audit-level high` still fails on any other advisory. Remove the entry when picomatch publishes a fix |

## Hardening checklist for operators

- [ ] Set a fixed `SEARCH_HUB_ENCRYPTION_KEY` and back it up.
- [ ] Serve over HTTPS via a reverse proxy; set `SEARCH_HUB_COOKIE_SECURE=true` and `SEARCH_HUB_TRUST_PROXY=true` (loopback-only) or an explicit proxy CIDR such as `172.17.0.0/16`.
- [ ] Set `SEARCH_HUB_PUBLIC_URL` and, if you use additional hostnames, `SEARCH_HUB_ALLOWED_HOSTS`.
- [ ] Set `SEARCH_HUB_SETUP_TOKEN` before exposing the instance publicly, or read the generated token from `data/setup-token` and keep it private. The token value is never written to the log.
- [ ] Do not expose port 8787 directly to the internet.
- [ ] Create one token per integration with the narrowest scope; revoke unused tokens.
- [ ] Review `/api/admin/audit` periodically for unexpected admin actions.
- [ ] Keep the private host allowlist empty unless you truly need internal destinations.
- [ ] If you deploy behind an HTTP proxy, set `SEARCH_HUB_PROXY` and declare `SEARCH_HUB_PROXY_TRUST` explicitly (`untrusted` unless the proxy itself enforces an egress ACL); verify `GET /api/admin/outbound` shows `privateHostAllowlistHonored: false` and no `residualRisk` you did not intend.
- [ ] Run `pnpm audit` after dependency updates.

## Maintainers

Maintainer: [@alicia1030su](https://github.com/alicia1030su). Security reports must use the private advisory link above, not a public issue or a direct message.
