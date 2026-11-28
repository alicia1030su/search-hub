# MCP server

Search Hub exposes the same search core over the Model Context Protocol through the official TypeScript SDK v2:

- `@modelcontextprotocol/server` **2.4.0**
- Implements the **2026-07-28** revision, and also serves 2025-era clients statelessly from the same factory.

Two transports:

| Transport | Use case | Auth |
|---|---|---|
| Streamable HTTP (`POST /mcp`) | Remote clients, web IDE plugins | `Authorization: Bearer sh_...` with `mcp:use` |
| stdio (`packages/mcp/dist/stdio.mjs`) | Local desktop clients | Proxies REST, so the same token is used |

## Protocol eras

The SDK distinguishes the two eras by the opening exchange:

**2025-11-25 (legacy, stateless)** — a client sends `initialize`, then `tools/list` / `tools/call`. No session is kept between requests; each request is served by a fresh server instance from the same factory. This is what most clients do today.

**2026-07-28 (modern)** — no `initialize`. Every request carries:

- header `MCP-Protocol-Version: 2026-07-28`
- header `Mcp-Method: tools/list` (or `tools/call`)
- header `Mcp-Name: <tool>` for `tools/call`
- `params._meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`

Mixing an `initialize` body with a modern version header is rejected with `400` and a message explaining the mismatch; it is never silently downgraded.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `search_web` | `query`, `limit`, `language`, `freshness`, `providers` | Fused results, errors, timing |
| `search_multi` | `queries[]`, `limit`, `language` | One merged result list |
| `search_deep` | `query`, `limit`, `language` | Rewritten queries, results, cited summary |
| `fetch_webpage` | `url`, `maxContentChars?` | Bounded Markdown/text with stable `readStatus` and `reasonCode`; never launches a browser |
| `search_news` | `query`, `limit`, `language` | Results restricted to the last day |
| `search_with_sources` | `query`, `limit`, `language` | Results plus per-provider diagnostics and dedupe counts |
| `search_and_rerank` | `query`, `limit`, `rerankModelId?` | Results with `rerankScore` |
| `search_and_summarize` | `query`, `limit`, `chatModelId?` | Results plus a cited summary |
| `get_search_sources` | — | Provider list and runtime health |
| `get_provider_health` | `status?` | Read-only provider health overview within the token's visible scope |
| `get_search_status` | — | Key states, in-flight counts, breaker state |

Sensitive admin operations are **not** exposed as tools. There is no provider/key mutation over MCP.

Tool failures are returned as MCP tool errors (`isError: true`) with a readable message; a server crash is never the failure mode.

## Client configuration

### Streamable HTTP

```json
{
  "mcpServers": {
    "search-hub": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sh_your_token"
      }
    }
  }
}
```

### stdio

```json
{
  "mcpServers": {
    "search-hub": {
      "command": "node",
      "args": ["/path/to/search-hub/packages/mcp/dist/stdio.mjs"],
      "env": {
        "SEARCH_HUB_URL": "http://127.0.0.1:8787",
        "SEARCH_HUB_TOKEN": "sh_your_token"
      }
    }
  }
}
```

Or inside the container:

```bash
docker compose exec -i \
  -e SEARCH_HUB_URL=http://127.0.0.1:8787 \
  -e SEARCH_HUB_TOKEN=sh_your_token \
  search-hub node packages/mcp/dist/stdio.mjs
```

The bundle is plain JavaScript; no `tsx`, TypeScript, or network install is required. `SEARCH_HUB_TOKEN` needs `mcp:use`, `search`, and (for `get_search_sources` and `get_search_status`) `sources:read`.

## Verifying with curl

Legacy handshake:

```bash
curl -sS http://localhost:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Modern request:

```bash
curl -sS http://localhost:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2026-07-28" \
  -H "mcp-method: tools/call" \
  -H "mcp-name: search_web" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_web","arguments":{"query":"mcp","limit":3},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Security

- Bearer token required for every request; tokens are revocable and scoped.
- **Host validation happens before authentication.** Accepted: IP literals, `localhost`, the hostname of `SEARCH_HUB_PUBLIC_URL`, and entries in `SEARCH_HUB_ALLOWED_HOSTS`. Anything else gets `403`, which blocks DNS rebinding before a token can be probed.
- `Origin` is checked when present; browser calls must be same-origin (scheme, host, and effective port) or exactly match an entry in `SEARCH_HUB_CORS_ORIGINS`.
- Behind a reverse proxy, terminate TLS there and set `SEARCH_HUB_PUBLIC_URL` plus `SEARCH_HUB_TRUST_PROXY=true` (loopback-only) or an explicit proxy CIDR.
- The endpoint requires a Bearer token; the admin session cookie is not accepted. Keep the token secret and never embed it in client-side code.
- Tool output never contains provider API keys.

## Known limits

- `responseMode: "json"` — mid-call notifications/progress are dropped. Streaming subscriptions are not implemented.
- Tools return a single JSON result. REST `/api/search/stream` SSE/NDJSON support does not add server-initiated MCP streaming.
- No OAuth authorization-server flow; access tokens are issued by the admin UI.
- stdio is a REST proxy. If the API is down, stdio calls fail by design.
