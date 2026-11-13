---
name: Bug report
about: Report a defect with enough evidence to reproduce it
title: "[bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

## What happened

<!-- One paragraph. What did you expect, what happened instead? -->

## Reproduction

```bash
# Exact commands. Do not include API keys, tokens, cookies, or internal hostnames.
```

## Evidence

<!-- Paste the error code, HTTP status, and the relevant log lines with secrets removed. -->
<!-- Search Hub error shape: {"error":{"code":"...","message":"..."}} -->

```text
```

## Environment

| Item | Value |
|---|---|
| Search Hub version | <!-- `curl -s localhost:8787/api/health | jq -r .version` --> |
| Deployment | Docker Compose / bare-metal / other |
| Node version | <!-- node -v --> |
| OS / arch | |
| Provider type(s) involved | |
| Proxy in use | no / yes (HTTP / CONNECT), **never paste the proxy URL with credentials** |

## Checks

- [ ] I removed all secrets, tokens, cookies, and private hostnames from this report.
- [ ] I searched existing issues.
- [ ] This is reproducible on a **fresh** data directory (or I explain why not).

## Additional context

<!-- Screenshots, backup verify output, `search-quality` numbers, etc. -->
