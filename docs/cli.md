# Search Hub CLI (`shub`)

`shub` is a standalone remote client for Search Hub. It does not embed the
server, SQLite, Redis, Docker, provider adapters, key scheduling, RRF, caching,
health probes or model calls. Every command uses the existing REST API.

## Install

Download the matching asset from the
[v0.1.18 Release](https://github.com/alicia1030su/search-hub/releases/tag/v0.1.18):

| Platform | Asset | Requirements |
|---|---|---|
| Windows x64 | `shub-v0.1.18-windows-x64.zip` | None |
| Linux x64 | `shub-v0.1.18-linux-x64.tar.gz` | None |
| Linux arm64 | `shub-v0.1.18-linux-arm64.tar.gz` | None |
| Portable | `shub-v0.1.18-node22.tar.gz` | Node.js >=22.12.0 |

Extract the archive and run `shub` (`shub.exe` on Windows). Verify downloads with
`sha256sum -c SHA256SUMS` and, optionally,
`gh attestation verify <asset> --repo alicia1030su/search-hub`.

## Configuration

```bash
export SEARCH_HUB_URL="https://search.example.com"
export SEARCH_HUB_TOKEN="sh_..."
shub status
```

PowerShell:

```powershell
$env:SEARCH_HUB_URL = "https://search.example.com"
$env:SEARCH_HUB_TOKEN = "sh_..."
.\shub.exe status
```

Precedence is `--url` > `SEARCH_HUB_URL` > local non-sensitive config >
`http://127.0.0.1:8787`. Plain HTTP is accepted only for loopback hosts. Remote
HTTP, URL userinfo, query strings and fragments are rejected.

Tokens are read only from `SEARCH_HUB_TOKEN` or `--token-stdin`; `shub` never
writes them to its config file. Config commands manage only the URL:

```bash
shub config set url https://search.example.com
shub config get url
shub config list
shub config reset
```

## Commands

```bash
shub search "Linux 内核最新变化"
shub search "AI" --limit 20 --provider prv_xxx --mode rrf
shub search "AI 搜索技术" --mode deep
shub search "AI 搜索技术" --mode deep --stream --format ndjson
shub fetch https://www.python.org/ --json
shub sources
shub sources --enabled --json
shub status
shub doctor --verbose
shub providers test prv_xxx --kind connect
shub providers test --all --kind search --confirm-cost
shub providers test --all --include-keyless --json
shub providers test --job job_xxx
shub providers test --cancel job_xxx
shub backup create --output backup.shbackup --passphrase-stdin
shub backup verify backup.shbackup --passphrase-stdin
shub backup restore backup.shbackup --data-dir /srv/search-hub-restored --passphrase-stdin
shub backup restore backup.shbackup --data-dir /srv/search-hub-restored --apply --start-check --passphrase-stdin
shub doctor --local --data-dir /var/lib/search-hub
```

`search` maps only real REST fields: `providers`, `group`, `limit`, `mode`,
`language`, `freshness` and `timeoutMs`. Deep mode calls `/api/search/deep`; the
server owns model selection and execution. `fetch` calls the shared
`POST /api/web/read` service and returns bounded text or a stable `readStatus` /
`reasonCode`; it does not start a browser.

`sources` requires `sources:read`. `providers test` requires an `admin`-scope
Bearer token. It performs a read-only preview first, skips missing/disabled keys,
keeps keyless sources opt-in, and requires `--confirm-cost` in unattended mode
when the preview reports potential paid probes.

## Local backup maintenance

`backup create|verify|restore` and `doctor --local` run without a remote server. They honour `SEARCH_HUB_DATA_DIR`, `SEARCH_HUB_DB_PATH` and `SEARCH_HUB_MIGRATIONS_DIR`. Passphrases come only from `--passphrase-stdin` or `SEARCH_HUB_BACKUP_PASSPHRASE`; interactive TTY input is hidden and there is deliberately no passphrase argv option. Complete packages use the `.shbackup` extension and contain exactly `manifest.json`, `data/search-hub.db` and `keys/master.key` in that order. Verification is streaming for files larger than the HTTP 64 MiB cap. For restore, `--data-dir` selects the new target while `SEARCH_HUB_DATA_DIR` and `SEARCH_HUB_INSTALL_DIR` identify the original source locations for the origin guard; the target must not equal, contain or be contained by either source path. Restore refuses non-empty targets, defaults to dry-run when neither `--dry-run` nor `--apply` is supplied, and supports `--report <file>` and isolated `--start-check` with `--apply`. See [disaster recovery](./disaster-recovery.md) for Bash and PowerShell examples.

## Output and exit codes

`--json` is an alias for `--format json`. Without `--stream`, JSON mode writes
exactly one JSON value to stdout and diagnostics go to stderr. Non-streaming
`--format ndjson` emits explicit `metadata`, `result`, and `complete` records with
`streaming:false`.

`--stream` consumes the real `/api/search/stream` endpoint (SSE by default).
Use `--stream --format ndjson` for one live event object per line; events carry
`streaming:true`, temporary result sets are marked `resultSet:"temporary"`, and
the terminal event is marked `resultSet:"final"`. `--stream --json` emits one JSON
object per event rather than a single JSON document, so NDJSON is the safer
machine format. The default table output prints progress and temporary updates,
then the authoritative final table.

| Code | Meaning |
|---:|---|
| 0 | Completed (partial also returns 0 unless `--strict`) |
| 2 | Invalid arguments or unsafe URL |
| 3 | Missing/invalid authentication |
| 4 | Insufficient scope |
| 5 | Network, DNS, TLS or unsafe redirect |
| 6 | Server/search/probe failure, or strict partial |
| 7 | Timeout |
| 8 | Incompatible server version |
| 9 | Page fetched but unavailable; inspect `readStatus` / `reasonCode` |
| 130 | Ctrl+C |

Ctrl+C aborts local waiting. During `--stream`, closing the connection cancels
the server-side search and the CLI returns 130 for a cancelled terminal event.
Non-streaming requests keep the existing disconnect behavior. Billable
`POST /api/search` requests are never retried.

## Compatibility

The v0.1.18 CLI accepts server versions `0.1.12` and later within `0.1.x`.
Compatible fields remain usable; a missing endpoint fails explicitly instead of
being treated as an empty success.
