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

### Data

`./data` is the only stateful volume:

| Path | Contents |
|---|---|
| `data/search-hub.db` | SQLite database (WAL files alongside) |
| `data/master.key` | Encryption key generated on first start if env key is absent |

**Back up both together.** Without `master.key` (or the env key) stored API keys cannot be decrypted.

```bash
docker compose stop search-hub
tar czf search-hub-backup-$(date +%F).tgz data/
docker compose start search-hub
```

Restore into a fresh directory before starting the container. Migrations run automatically on boot and only add/alter tables; they never drop stored keys.

### Upgrade

```bash
docker compose pull
docker compose up -d
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
    proxy_buffering off;          # keep SSE-capable responses working
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
corepack pnpm install --prod
corepack pnpm build            # build the web bundle
SEARCH_HUB_DATA_DIR=/var/lib/search-hub \
SEARCH_HUB_PORT=8787 \
NODE_ENV=production \
node --import tsx apps/api/src/index.ts
```

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
ExecStart=/usr/bin/node --import tsx apps/api/src/index.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`SIGTERM` triggers a clean shutdown: the scheduler flushes counters, then SQLite closes.

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
