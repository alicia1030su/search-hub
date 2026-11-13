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

When `SEARCH_HUB_SETUP_TOKEN` is empty, the server generates a one-time token at `/app/data/setup-token` (0600) and prints it to the log. Read it with `docker compose logs search-hub | grep "setup token"` or `docker compose exec search-hub cat /app/data/setup-token`. The file disappears after initialization.

### Data

The compose file uses the named volume `search-hub-data` mounted at `/app/data`. Docker initialises it with the image's non-root owner (uid 1001), so no manual `chown` is required. If you prefer a bind mount, create it first and `chown 1001:1001`.

| Path | Contents |
|---|---|
| `search-hub.db` | SQLite database (WAL sidecars while running) |
| `master.key` | Encryption key generated on first start if no env key is set |
| `setup-token` | One-time first-run token (deleted after initialization) |

**Back up the database and `master.key` together.** Without the key, stored API keys cannot be decrypted.

```bash
# Consistent database snapshot without stopping the service:
curl -s -b cookies.txt -o backup.db http://127.0.0.1:8787/api/admin/backup

# Or stop, then archive the whole volume including master.key:
docker compose stop search-hub
docker run --rm -v search-hub_search-hub-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/search-hub-backup-$(date +%F).tgz -C /data .
docker compose start search-hub
```

A file-level copy while the service is running must include `search-hub.db`, `search-hub.db-wal` and `search-hub.db-shm`; copying only `.db` loses recent writes (observed during v0.1.1 acceptance: 383 KB of WAL was not in the main file). The API endpoint runs `wal_checkpoint(TRUNCATE)` first, so its output is self-contained.

Restore into a fresh volume before starting the container. Migrations run automatically on boot and only add/alter tables; they never drop stored keys.

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
# Consistent snapshot (WAL checkpointed, no -wal/-shm sidecars needed):
curl -s -b cookies.txt -o backup.db https://search.example.com/api/admin/backup

# Or offline: stop the container, then copy data/search-hub.db and data/master.key.
```

`master.key` is **not** included in the API download: without it the restored database cannot decrypt stored provider keys, which is the safe failure mode. Back it up separately (or keep using `SEARCH_HUB_ENCRYPTION_KEY`) and store it outside the web root.

Restore: stop the service, copy `search-hub.db` (and `master.key` or the same env key) into the data directory, start again. Migrations are applied automatically on boot.

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
