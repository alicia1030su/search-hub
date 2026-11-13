---
name: Security report
about: Report a vulnerability privately (do not open a public issue for exploitable bugs)
title: "[security] "
labels: ["security"]
assignees: []
---

> **Stop.** If this is an exploitable vulnerability in a deployed instance, do **not** file a public issue.
> Follow the private disclosure process in [SECURITY.md](../SECURITY.md) instead.
> This template is for hardening suggestions, defense-in-depth ideas, and issues in code that is not deployed.

## Scope

| Item | Value |
|---|---|
| Affected version | |
| Component | safe-fetch / MCP / auth / backup / provider / admin UI / other |
| Attack prerequisite | network access / valid low-scope token / admin session / local access |

## Description

<!-- What can an attacker do that they should not be able to do? -->

## Reproduction

<!-- Steps or a test case. Use local mock servers only; never probe third-party or internal assets. -->

## Impact

<!-- Confidentiality / integrity / availability, and the trust boundary that is crossed. -->

## Suggested fix

<!-- Optional. If you have a patch, describe the approach; do not include secrets. -->

## Checklist

- [ ] This is not an exploitable issue in a public deployment (otherwise I used SECURITY.md).
- [ ] I did not include secrets, tokens, cookies, proxy credentials, or internal hostnames.
- [ ] I tested only against my own instance / local mocks.
