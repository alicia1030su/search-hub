# Deployment

Target: a 2-core / 2 GB Linux host can run basic search comfortably. No Redis, vector database, GPU, or external model is required.

## Docker Compose

```bash
cp .env.example .env
# Set a stable master key (recommended):
#   openssl rand -hex 32
#   SEARCH_HUB_ENCRYPTION_KEY=<64 hex chars>
docker compose up -d
docker compose logs -f search-hub
curl -fsS http://127.0.0.1:8787/api/health
```

Open `http://<host>:8787` and create the administrator. There is no default account.

Compose-level knobs (all optional): `SEARCH_HUB_HOST_PORT` (host port, default `8787`),
`SEARCH_HUB_CONTAINER_NAME` (default `search-hub`), `SEARCH_HUB_IMAGE` (use a published
image instead of a local build), `SEARCH_HUB_MEM_LIMIT` (default `1g`).

The service runs with `cap_drop: [ALL]`, `no-new-privileges`, `init: true`,
a 30 s stop grace period and json-file log rotation (10 MB × 3). It does not need
any Linux capability: it binds an unprivileged port and writes only to the volume.

When `SEARCH_HUB_SETUP_TOKEN` is empty, the server generates a one-time token at `/app/data/setup-token` (0600) and prints it to the log. Read it with `docker compose logs search-hub | grep "setup token"` or `docker compose exec search-hub cat /app/data/setup-token`. The file disappears after initialization.

Container-level acceptance (image build, compose stack, restart, persistence,
resource footprint, crash recovery, vulnerability scan) is covered by
[`docker-verification.md`](./docker-verification.md) and `scripts/docker-verify.sh`.

### Data

The compose file uses the named volume `search-hub-data` mounted at `/app/data`. Docker initialises it with the image's non-root owner (uid 1001), so no manual `chown` is required. If you prefer a bind mount, create it first and `chown 1001:1001`.

| Path | Contents |
|---|---|
| `search-hub.db` | SQLite database (WAL sidecars while running) |
| `master.key` | Encryption key generated on first start if no env key is set |
| `setup-token` | One-time first-run token (deleted after initialization) |

**Back up the database and `master.key` together.** Without the key, stored API keys cannot be decrypted.

```bash
# Compose prefixes volume names with the project name (the directory name by
# default). Resolve it instead of hard-coding "search-hub_...", which breaks
# when the checkout directory has a different name.
VOLUME=$(docker volume ls -q \
  --filter label=com.docker.compose.project="$(basename "$PWD")" \
  --filter label=com.docker.compose.volume=search-hub-data)
[ -n "$VOLUME" ] || { echo "volume not found; start the stack once first" >&2; exit 1; }
# Consistent database snapshot without stopping the service:
curl -s -b cookies.txt -o backup.db http://127.0.0.1:8787/api/admin/backup

# Or stop, then archive the whole volume including master.key:
docker compose stop search-hub
docker run --rm -v "$VOLUME":/data -v "$PWD":/backup alpine \
  tar czf /backup/search-hub-backup-$(date +%F).tgz -C /data .
docker compose start search-hub
```

A file-level copy while the service is running must include `search-hub.db`, `search-hub.db-wal` and `search-hub.db-shm`; copying only `.db` loses recent writes (observed during v0.1.1 acceptance: 383 KB of WAL was not in the main file). The API endpoint below takes a real snapshot instead — do not rely on a manual `cp` of `.db` while the service is up.

Restore into a fresh volume before starting the container. Migrations run automatically on boot and only add/alter tables; they never drop stored keys.

#### How `GET /api/admin/backup` builds the snapshot

The endpoint uses the **SQLite Online Backup API** (`better-sqlite3`'s `db.backup()`), not a checkpoint followed by a file read. The difference matters:

| Approach | Behaviour with concurrent writes |
|---|---|
| `wal_checkpoint(TRUNCATE)` + `readFile` (v0.1.1) | Writers that commit between the checkpoint and the read land in `-wal`; the copied `.db` opens fine but silently misses those transactions |
| `db.backup()` (SQLite Online Backup API) | Pages are copied inside the source connection's read transactions; writes issued meanwhile are propagated into the copy or restart it — the result is always a valid committed state, never a torn page set |
| `VACUUM INTO` (fallback) | Same consistency guarantee; used when the native build lacks the backup API. Requires SQLite ≥ 3.27.0 |

After copying, the snapshot is normalised and verified before it is visible to the client:

1. `PRAGMA journal_mode = DELETE` — checkpoints any WAL content into the file so the download is a single self-contained `.db` with no `-wal`/`-shm` sidecars;
2. `PRAGMA user_version = <applied migration count>` — a cheap version marker for restores;
3. `PRAGMA integrity_check` on a read-only connection — must return `ok`;
4. atomic `rename` from `<name>.<random>.tmp` to the final name.

Any failure deletes the temp file and returns a JSON error, so a failed backup never produces a truncated file that looks usable. Response headers:

| Header | Meaning |
|---|---|
| `x-search-hub-schema-version` | Newest applied migration, e.g. `0001_init.sql` |
| `x-search-hub-user-version` | `PRAGMA user_version` of the snapshot |
| `x-search-hub-snapshot-method` | `sqlite_backup_api` or `vacuum_into` |
| `x-search-hub-integrity` | Always `ok` (a failed check returns an error instead) |

The snapshot is streamed to the client and deleted from `<data>/snapshots/` once the response finishes. Leftovers from a crashed download are swept on the next successful backup. `master.key` is never included.

#### Verifying a snapshot before restoring

`POST /api/admin/backup/verify` checks a downloaded file without restoring it:

```bash
# Send the raw file body (64 MB cap)
curl -s -b cookies.txt -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/octet-stream' \
  --data-binary @backup.db \
  https://search.example.com/api/admin/backup/verify | jq
```

```json
{
  "ok": true,
  "compatible": true,
  "integrity": "ok",
  "isSqliteFile": true,
  "isSearchHubDatabase": true,
  "schemaVersion": "0001_init.sql",
  "userVersion": 1,
  "migrations": ["0001_init.sql"],
  "knownMigrations": ["0001_init.sql"],
  "pendingMigrations": [],
  "tables": ["admin_users", "api_keys", "provider_instances", "..."],
  "rowCounts": { "admin_users": 1, "api_keys": 3, "provider_instances": 4, "search_tasks": 412 },
  "bytes": 438272
}
```

A snapshot taken by a **newer** release reports `ok: false, compatible: false, reason: "backup was created by a newer version"` — restoring it with older code is refused. `pendingMigrations` lists migrations the snapshot is missing (an older backup: restore is allowed, they run on boot). A valid SQLite file that is not a Search Hub database (no `_migrations` table) reports `isSearchHubDatabase: false` with a matching `reason`, so an unrelated `.db` is never accepted as a backup.

#### Version compatibility is enforced at startup

`runMigrations` compares `_migrations` against `packages/db/migrations` on every boot. If the database records a migration file this build does not ship, the process **exits with a non-zero code** and logs:

```
Database schema is newer than this build: 0002_x.sql is applied but not present in .../migrations.
```

That is deliberate: starting older code against a newer schema would read tables it does not understand. Fix by upgrading the application, not by deleting rows from `_migrations`.

#### Restore procedure

```bash
# Compose prefixes volume names with the project name (the directory name by
# default). Resolve it instead of hard-coding "search-hub_...", which breaks
# when the checkout directory has a different name.
VOLUME=$(docker volume ls -q \
  --filter label=com.docker.compose.project="$(basename "$PWD")" \
  --filter label=com.docker.compose.volume=search-hub-data)
[ -n "$VOLUME" ] || { echo "volume not found; start the stack once first" >&2; exit 1; }
# 1. Stop the service (or the container).
docker compose stop search-hub

# 2. Verify the file you are about to restore.
curl -s -b cookies.txt -H 'content-type: application/octet-stream' \
  --data-binary @backup.db https://search.example.com/api/admin/backup/verify | jq '.ok, .schemaVersion'

# 3. Replace the database and the master key together.
docker run --rm -v "$VOLUME":/data -v "$PWD":/backup alpine \
  sh -c 'cp /backup/backup.db /data/search-hub.db && rm -f /data/search-hub.db-wal /data/search-hub.db-shm'
# Copy master.key only if you are restoring onto a host that lost it:
docker run --rm -v "$VOLUME":/data -v "$PWD":/backup alpine \
  sh -c 'cp /backup/master.key /data/master.key && chmod 600 /data/master.key'

# 4. Start again; migrations for this build run automatically.
docker compose start search-hub
```

Without `master.key` (or the same `SEARCH_HUB_ENCRYPTION_KEY`) the restored instance keeps its providers and history, but stored provider/model keys cannot be decrypted and must be re-entered in the UI.

A repeatable end-to-end check of this whole flow — concurrent writes, three downloads, restore into a fresh directory, newer-schema refusal, and failure handling — is `node tests/scripts/backup-restore.mjs`.

### Upgrade

```bash
git pull            # or download the new source tarball
docker compose up -d --build
```

The API applies any new `packages/db/migrations/*.sql` at startup. Read `CHANGELOG.md` first; a migration that requires manual action will be called out there.

### Health check

The image and compose file both call:

```
GET /api/health  →  {"status":"ok", ...}
```

It reports setup status, provider counts, and whether the master key came from env or file (never the key itself).

## Behind a reverse proxy

```nginx
server {
  listen 443 ssl http2;
  server_name search.example.com;

  client_max_body_size 2m;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # keeps long MCP JSON responses intact
    proxy_read_timeout 120s;
  }
}
```

Set:

```env
SEARCH_HUB_PUBLIC_URL=https://search.example.com
SEARCH_HUB_COOKIE_SECURE=true
SEARCH_HUB_TRUST_PROXY=true
```

`SEARCH_HUB_TRUST_PROXY=true` makes Fastify trust `X-Forwarded-*`; only enable it behind a proxy you control, otherwise client-IP rate limiting can be spoofed.

Do not expose port 8787 directly to the internet.

## Manual / bare-metal

```bash
# 1) Build once with full dependencies (the bundler needs dev dependencies).
corepack pnpm install --frozen-lockfile
corepack pnpm build          # -> apps/web/dist + apps/api/dist/server.mjs + packages/mcp/dist/stdio.mjs

# 2) Drop dev dependencies in place (no rebuild afterwards).
corepack pnpm install --frozen-lockfile --prod

# 3) Run the compiled server. tsx/TypeScript are NOT needed at runtime.
SEARCH_HUB_DATA_DIR=/var/lib/search-hub \
SEARCH_HUB_PORT=8787 \
NODE_ENV=production \
node apps/api/dist/server.mjs
```

Order matters: `pnpm build` needs esbuild/vite/TypeScript, which `--prod` prunes. The bundle keeps third-party packages external, so they are resolved from `node_modules` at runtime; `apps/api/migrations` is copied next to the bundle by the build script (or point `SEARCH_HUB_MIGRATIONS_DIR` at it).

Verified on a copy of the repository with no prior `node_modules`: `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm install --frozen-lockfile --prod` → `node apps/api/dist/server.mjs` served `/api/health` 200 and the web bundle.

### MCP stdio without a TypeScript toolchain

`packages/mcp/dist/stdio.mjs` is a self-contained bundle. Any client can spawn it directly with the Node runtime already on the host:

```json
{
  "mcpServers": {
    "search-hub": {
      "command": "node",
      "args": ["/opt/search-hub/packages/mcp/dist/stdio.mjs"],
      "env": {
        "SEARCH_HUB_URL": "http://127.0.0.1:8787",
        "SEARCH_HUB_TOKEN": "sh_your_token"
      }
    }
  }
}
```

It is a REST proxy: it needs `SEARCH_HUB_URL` and `SEARCH_HUB_TOKEN` (scopes `mcp:use`, `search`, and `sources:read` for `get_search_sources`). If the REST service is down, stdio calls fail — that is the intended proof that there is only one search implementation.

### First-run setup token

The instance refuses to create an administrator without the one-time token:

```bash
# Either pin it:
SEARCH_HUB_SETUP_TOKEN="$(openssl rand -base64 24)" node apps/api/dist/server.mjs
# Or read the generated file (mode 0600) after the first start:
cat /var/lib/search-hub/setup-token
```

The file is deleted automatically once the administrator exists.

### Reverse proxy and trust boundary

Set `SEARCH_HUB_PUBLIC_URL` to the external HTTPS origin and add any extra hostnames (for a second domain, an internal name, or an IP) to `SEARCH_HUB_ALLOWED_HOSTS`. Requests whose Host header is neither an IP literal, `localhost`, nor an allowlisted hostname get **403** before authentication, which blocks DNS-rebinding.

`SEARCH_HUB_TRUST_PROXY=true` trusts only loopback proxies (`127.0.0.1/8`, `::1/128`); if your proxy runs in another container, give its CIDR explicitly: `SEARCH_HUB_TRUST_PROXY=172.17.0.0/16`. Never set it to a value that trusts arbitrary peers, or `X-Forwarded-For` can be spoofed to bypass login throttling and audit attribution.

Use systemd:

```ini
[Unit]
Description=Search Hub
After=network.target

[Service]
Type=simple
User=searchhub
WorkingDirectory=/opt/search-hub
Environment=NODE_ENV=production
Environment=SEARCH_HUB_DATA_DIR=/var/lib/search-hub
Environment=SEARCH_HUB_PORT=8787
Environment=SEARCH_HUB_COOKIE_SECURE=true
Environment=SEARCH_HUB_PUBLIC_URL=https://search.example.com
Environment=SEARCH_HUB_MIGRATIONS_DIR=/opt/search-hub/apps/api/migrations
ExecStart=/usr/bin/node apps/api/dist/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`SIGTERM` triggers a clean shutdown: the scheduler flushes counters, then SQLite closes.

### Backup and restore

```bash
# Consistent snapshot (online backup API, integrity-checked, single self-contained .db):
curl -s -b cookies.txt -o backup.db https://search.example.com/api/admin/backup

# Verify it before you need it:
curl -s -b cookies.txt -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/octet-stream' --data-binary @backup.db \
  https://search.example.com/api/admin/backup/verify

# Or offline: stop the container, then copy data/search-hub.db and data/master.key.
```

`master.key` is **not** included in the API download: without it the restored database cannot decrypt stored provider keys, which is the safe failure mode. Back it up separately (or keep using `SEARCH_HUB_ENCRYPTION_KEY`) and store it outside the web root.

Restore: stop the service, copy `search-hub.db` (and `master.key` or the same env key) into the data directory, start again. Migrations are applied automatically on boot. A database whose schema is *newer* than the running build is refused at startup rather than half-read — see "Backup and restore" above.

## Environment reference

| Variable | Default | Notes |
|---|---|---|
| `SEARCH_HUB_HOST` | `0.0.0.0` | Bind address |
| `SEARCH_HUB_PORT` | `8787` | HTTP port |
| `SEARCH_HUB_DATA_DIR` | `<repo>/data` | Database + master key |
| `SEARCH_HUB_DB_PATH` | `<data>/search-hub.db` | Override the database file |
| `SEARCH_HUB_ENCRYPTION_KEY` | generated | 64 hex chars; must be stable |
| `SEARCH_HUB_SETUP_TOKEN` | unset | Required on the first-run form when set |
| `SEARCH_HUB_PUBLIC_URL` | unset | Used in MCP/Skill examples and links |
| `SEARCH_HUB_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `SEARCH_HUB_TRUST_PROXY` | `false` | Only behind a trusted proxy |
| `SEARCH_HUB_CORS_ORIGINS` | empty | Comma-separated extra origins |
| `SEARCH_HUB_LOG_LEVEL` | `info` | `fatal`…`trace` |
| `SEARCH_HUB_STATIC_DIR` | `apps/web/dist` | Pre-built UI location |
| `SEARCH_HUB_BACKUP_MAX_UPLOAD_BYTES` | `67108864` (64 MB) | Cap for `POST /api/admin/backup/verify` uploads |
| `SEARCH_HUB_PROXY` | unset | `http(s)://` forward proxy for all provider/model traffic. `socks5://` / `pac+http://` / `file://` are rejected at boot. See `SECURITY.md` “Outbound network and proxy trust boundary”. |
| `SEARCH_HUB_NO_PROXY` | unset | Bypass list (`NO_PROXY` semantics: `*.example.com`, `host:port`, `10.0.0.0/8`, `*`). Bypassed targets are still SSRF-validated and keep the connect-time guard. |
| `SEARCH_HUB_PROXY_TRUST` | unset | `untrusted`/`application-only` or `trusted-networks`/`egress-enforced`. Unset keeps the private host allowlist ineffective for proxied hops and flags the undeclared boundary on `/api/health`. |
| `SEARCH_HUB_PROXY_FROM_ENV` | `false` | `true` also honours ambient `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`; still requires `SEARCH_HUB_PROXY_TRUST` or boot fails |

### Deploying behind an HTTP proxy

Some networks have no direct egress. Set `SEARCH_HUB_PROXY` to an `http://` or `https://` forward proxy and add the hosts that must not go through it to `SEARCH_HUB_NO_PROXY`.

**What the application still enforces** (every request, every redirect hop, in both modes): http(s) only, no embedded credentials, DNS resolution + CIDR classification (loopback, RFC1918, CGNAT, link-local, multicast, reserved, IPv6 ULA/link-local), cloud metadata addresses always rejected, internal hostnames (`localhost`, `*.local`, `metadata.google.internal`) rejected. Rejected targets never reach the proxy — no `CONNECT` is issued for them.

**What only the proxy can enforce:** which address the tunnel actually dials, whether internal ranges are reachable through it, and its own logging/rate limiting. Because the proxy resolves the destination, the connect-time IP pinning that protects direct connections cannot apply to proxied traffic; a proxy-side DNS rebinding is not detectable by Search Hub.

That is why `SEARCH_HUB_PROXY_TRUST` has no default:

- leave it unset or set `untrusted` / `application-only` — proxied requests are limited to application-validated public targets, the private host allowlist is ignored for them, and `/api/health` reports `proxyTrustDeclared: false`;
- set `trusted-networks` / `egress-enforced` only after confirming the proxy itself blocks internal egress. Then allowlisted private targets may go through it.

Direct connections (no proxy configured, or a `NO_PROXY` match) keep the connect-time lookup guard, and an allowlisted private host stays reachable that way — that is how a self-hosted SearXNG keeps working when a proxy is configured for public traffic.

`GET /api/admin/outbound` shows the effective policy: redacted proxy endpoint, `NO_PROXY` list and count, whether the private host allowlist is honoured, and a one-line `residualRisk`. Proxy credentials are never logged or returned: the display form is `scheme://host:port`. `/api/health` is anonymous, so it only reports the coarse `mode` / `proxyTrust` / `proxyTrustDeclared` triple.

## Connecting to a service on the host or another server

A provider `baseUrl` such as `http://127.0.0.1:44475` is resolved **from inside the process that issues the request**. In a container that is the container's own loopback, not your host. Pick the address by deployment shape:

| Where Search Hub runs | Where the target runs | Address to enter |
|---|---|---|
| Bare metal / `pnpm start` | same machine | `http://127.0.0.1:<port>` |
| Container (Compose) | the **host** (Docker Desktop) | `http://host.docker.internal:<port>` |
| Container (Compose) | the **host** (Linux) | the host bridge address, usually `http://172.17.0.1:<port>` — confirm with `ip route \| grep default` |
| Compose service in the same network | another compose service | `http://<service-name>:<port>` |
| Any | another server | `http://<reachable hostname or IP>:<port>`, with the firewall open |
| Container | target listens on host loopback only | make the target listen on a container-reachable interface, or run it with `network_mode: host`. Do **not** disable SSRF validation to "make it work" |

Private, loopback and link-local targets are rejected by the SSRF policy unless the operator adds them to **Settings → Security → private host allowlist**. That allowlist is a deliberate declaration "this host is an intended internal destination", not a generic switch: every operator who can edit a provider can then reach that host.

The same applies to the legacy Search Hub adapter: see [legacy integration](./legacy-44475-integration.md) for the three network scenarios and the exact failure modes.

## Resource notes

- SQLite WAL + short transactions; network calls never run inside a transaction.
- Search latency is dominated by the slowest provider, not the database.
- The in-process key scheduler holds one small object per key; memory scales with key count, not request count.
- Retention defaults: tasks and events 30 days, audit logs 14 days, cleaned hourly. Adjust in Settings.
- Image size is dominated by Node and the production dependency tree. `@modelcontextprotocol/server` pulls some transitive packages; the runtime image includes only production dependencies.

These are design estimates. Measure your own host with `docker stats` and the dashboard before sizing a production deployment.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503` on every `/api/...` | API not ready / static missing | Check `docker compose logs`; confirm `apps/web/dist/index.html` exists |
| Login succeeds then every action is `403` | CSRF header missing | Use the UI; for scripts, read `csrfToken` from `/api/auth/session` |
| `Failed to decrypt a stored secret` | Master key changed or lost | Restore `master.key`; otherwise re-enter all keys |
| Brave returns `401` | Wrong/expired subscription token | Re-test the key in the UI |
| SearXNG returns `403` | JSON format disabled | Enable it in the instance's `settings.yml` |
| All requests `no_available_key` | Keys cooling down / quota exhausted | Inspect the key panel; raise limits or add keys |
| MCP `400` about headers/body disagreeing | Legacy `initialize` with a modern version header | Use one era consistently; see `docs/mcp.md` |
