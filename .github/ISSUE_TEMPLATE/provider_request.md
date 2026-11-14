---
name: Provider request
about: Request a new search source, or report that an existing adapter is wrong
title: "[provider] "
labels: ["provider"]
assignees: []
---

## Provider

| Item | Value |
|---|---|
| Name | |
| Official documentation URL | <!-- Required. Undocumented endpoints are not accepted. --> |
| Auth type | none / api key / bearer / other |
| Default base URL | |
| Public pricing / free tier | |

## Why

<!-- Which queries or languages does this cover that the current five adapters do not? -->

## Status honesty

Search Hub only marks a provider `live_tested` after a recorded real call. Pick one:

- [ ] I have a dedicated, revocable test key and can run `PROVIDER_API_KEY=... pnpm exec tsx tests/scripts/provider-live.mjs --provider <name>` (env only, never `--key`, never paste the key).
- [ ] I do not have a key. Implement it as `documented` with contract tests only.

## Response shape (if known)

```json
{
  "results": [
    { "title": "...", "url": "...", "snippet": "...", "publishedAt": "..." }
  ]
}
```

<!-- Paste the vendor's documented response example. Do not paste a real key. -->

## Error semantics (if known)

| Upstream status | Meaning |
|---|---|
| 401 / 403 | |
| 429 | retry-after header? |
| 402 | quota? |
| 5xx | |

## Checklist

- [ ] I linked the official documentation.
- [ ] I did not include any real API key, token, or internal hostname.
- [ ] I understand a mock-only test cannot promote the provider to `live_tested`.
