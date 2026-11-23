# Search Hub CLI (`shub`)

`shub` is a standalone remote client for Search Hub. It does not embed the
server, SQLite, Redis, Docker, provider adapters, key scheduling, RRF, caching,
health probes or model calls. Every command uses the existing REST API.

## Install

Download the matching asset from the
[v0.1.14 Release](https://github.com/alicia1030su/search-hub/releases/tag/v0.1.14):

| Platform | Asset | Requirements |
|---|---|---|
| Windows x64 | `shub-v0.1.14-windows-x64.zip` | None |
| Linux x64 | `shub-v0.1.14-linux-x64.tar.gz` | None |
| Linux arm64 | `shub-v0.1.14-linux-arm64.tar.gz` | None |
| Portable | `shub-v0.1.14-node22.tar.gz` | Node.js 22+ |

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
shub sources
shub sources --enabled --json
shub status
shub doctor --verbose
shub providers test prv_xxx --kind connect
shub providers test --all --kind search --confirm-cost
shub providers test --all --include-keyless --json
shub providers test --job job_xxx
shub providers test --cancel job_xxx
```

`search` maps only real REST fields: `providers`, `group`, `limit`, `mode`,
`language`, `freshness` and `timeoutMs`. Deep mode calls `/api/search/deep`; the
server owns model selection and execution.

`sources` requires `sources:read`. `providers test` requires an `admin`-scope
Bearer token. It performs a read-only preview first, skips missing/disabled keys,
keeps keyless sources opt-in, and requires `--confirm-cost` in unattended mode
when the preview reports potential paid probes.

## Output and exit codes

`--json` is an alias for `--format json`. JSON mode writes exactly one JSON value
to stdout; diagnostics go to stderr. `--format ndjson` emits explicit
`metadata`, `result` and `complete` records with `streaming:false`; the REST search
API is synchronous, so this is not real-time server streaming.

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
| 130 | Ctrl+C |

Ctrl+C aborts local waiting. `shub` does not silently cancel a server-side search
after a disconnect. Billable `POST /api/search` requests are never retried.

## Compatibility

The v0.1.14 CLI accepts server versions `0.1.12` and later within `0.1.x`.
Compatible fields remain usable; a missing endpoint fails explicitly instead of
being treated as an empty success.
