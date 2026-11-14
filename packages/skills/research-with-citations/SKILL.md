---
name: research-with-citations
description: Retrieve evidence through Search Hub and format a citation-ready source list with per-source attribution and verification status. Use when the output must be auditable, such as a report, a literature review, or a fact-check.
license: MIT
metadata:
  author: search-hub
  version: "0.1.3"
  requires: search-hub>=0.1.1
  transport: rest
---

# research-with-citations

Produce an auditable evidence table: every row a real URL, every URL traceable to the provider that returned it.

## When to use

- The deliverable needs a references section with stable links.
- You must distinguish primary sources from aggregator snippets.
- A reviewer will check your citations.

Use `search-web` when a plain answer is enough.

## Prerequisites

| Variable | Meaning |
|---|---|
| `SEARCH_HUB_URL` | Instance base URL |
| `SEARCH_HUB_TOKEN` | Token with the `search` scope |

## Call

```bash
curl -sS "$SEARCH_HUB_URL/api/search" \
  -H "authorization: Bearer $SEARCH_HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"query":"postgres logical replication","mode":"rrf","limit":12,"includeRaw":false}'
```

Use `search_with_sources` over MCP when you also need per-provider timing and failure reasons.

## Building the evidence table

For each result you keep, record:

| Column | Source field | Rule |
|---|---|---|
| Title | `title` | Verbatim. Never rewrite a headline into a stronger claim. |
| URL | `url` | Exactly as returned. Strip nothing. |
| Published | `publishedAt` | Copy as-is; write `unknown` when absent. Never guess a date. |
| Found via | `sources[].providerName` | All providers that returned it, comma-separated. |
| Retrieved | `retrievedAt` | ISO timestamp from the response. |
| Quote | `snippet` | Short excerpt; mark ellipses. |
| Score | `score` | Relative to this response only. Do not compare across queries. |

## Verification status

Search Hub returns provider health in `stats.providers`:

- `ok: true` — the provider answered.
- `ok: false` with `errorCode: "rate_limited"` — quota/rate limit; the result set may be missing that provider's coverage.
- `ok: false` with `errorCode: "auth_invalid"` — the key is suspended; results did not include that provider.
- `ok: false` with `errorCode: "timeout"` — the provider was too slow; coverage is incomplete.

If `status` is `partial`, say so in the references section: "Coverage incomplete: <provider> failed with <code>."

## Rules for citations

1. One URL per row. Do not merge two sources into one citation.
2. Prefer primary sources (specifications, official docs, papers) over aggregator pages; when only an aggregator is available, label it as secondary.
3. If a snippet is the only evidence, phrase the claim as "according to <title>" rather than as fact.
4. Do not cite a search result page as if it were the underlying document.
5. Keep the retrieved timestamp: pages change.
6. Never fabricate a URL, a date, or an author to fill a table cell.

## Example output

```markdown
## References

| # | Source | Published | Found via | Retrieved |
|---|--------|-----------|-----------|-----------|
| 1 | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | 2022-06 | brave-eu, searxng | 2026-11-13T04:00:00Z |
| 2 | [MDN HTTP caching](https://developer.mozilla.org/...) | unknown | searxng | 2026-11-13T04:00:00Z |
```

## Failure handling

| Situation | Action |
|---|---|
| All providers failed | Report the failure honestly; do not write a research note from memory. |
| Empty results, status completed | Broaden the query once, then report that the corpus had no match. |
| Only one provider returned results | Note the single-source limitation. |
| `auth_invalid` on a provider | Tell the user to re-test the key in Search Hub → Sources. |
