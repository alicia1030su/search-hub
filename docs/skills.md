# Agent Skills

Search Hub ships four skills in the standard [agentskills.io](https://agentskills.io) layout: a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`, optional `license`/`metadata`).

| Skill | Purpose | Needs |
|---|---|---|
| `search-web` | One search, top results with source attribution and citation rules | `search` scope |
| `deep-research` | Bounded multi-query retrieval → optional synthesis with numbered citations | `search` scope; chat model optional |
| `fetch-webpage` | Read one selected public page as bounded text with stable availability status | `search` scope |
| `research-with-citations` | Auditable evidence table (title, URL, date, provider, retrieved-at) | `search` scope |

Skill files: `packages/skills/<name>/SKILL.md`.

## Why not just point at the MCP docs?

An MCP tool description explains *how to call*; a skill explains *when to use it, how to read the output, what to do on failure, and how to cite*. The skills here encode:

- which mode to pick for which question,
- how to treat `partial` results and `failedSources`,
- the rule that a URL must never be reconstructed,
- how to mark a claim that rests only on a snippet,
- the degradation path when a model is unavailable.

They call the REST API, so they also work in clients that do not support MCP.

## Installing

### 1. Create a token

**Integrations → Access tokens → Create**, scope `search` (add `mcp:use` if the client also uses MCP). Copy it — it is shown once.

### 2. Export environment variables

```bash
export SEARCH_HUB_URL="https://search.example.com"
export SEARCH_HUB_TOKEN="sh_..."
```

All skills read these two variables. Do not put provider API keys in the client; Search Hub holds them.

### 3. Copy the skill directory

Most clients read skills from a directory such as `~/.claude/skills/` or a project-level `.skills/`. Copy the whole directory, not just the Markdown:

```bash
cp -r packages/skills/search-web ~/.claude/skills/
cp -r packages/skills/deep-research ~/.claude/skills/
cp -r packages/skills/fetch-webpage ~/.claude/skills/
cp -r packages/skills/research-with-citations ~/.claude/skills/
```

From the admin UI, **Integrations → Skills** previews each file and offers a download.

### 4. Confirm the client can execute

Ask the agent to run the skill on a trivial question and check that it performs an HTTP call to `/api/search` or, for `fetch-webpage`, `/api/web/read`. If the client cannot execute shell/HTTP, it can still read the instructions but must not claim it retrieved anything.

## Client support status

| Client | Loads `SKILL.md` | Can execute REST calls | Status |
|---|---|---|---|
| Claude Code–style skill directories | Yes | Yes (shell) | Documented layout; verify in your version |
| Generic agent frameworks reading agentskills.io | Depends on implementation | Depends | Not tested here |
| MCP-only clients | No | Via MCP tools instead | Use the MCP server |

We do **not** claim universal compatibility. The file format is standard; execution ability is client-specific.

## Example: search-web

```bash
curl -sS "$SEARCH_HUB_URL/api/search" \
  -H "authorization: Bearer $SEARCH_HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"query":"postgres full text search ranking","strategy":"balanced","limit":8}'
```

The skill instructs the agent to:

1. read the two environment variables (and stop if missing),
2. call with `strategy: "balanced"` (or legacy `mode: "rrf"`),
3. retry once with a broader query if results are empty but the status is `completed`,
4. keep results and disclose failures when the status is `partial`,
5. cite exact URLs and never invent one.

## Example: deep-research

```bash
curl -sS "$SEARCH_HUB_URL/api/search/deep" \
  -H "authorization: Bearer $SEARCH_HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"query":"How do self-hosted search aggregators rotate API keys?","limit":15}'
```

Response includes `deepBudget` (4 queries / 2 rounds / 32 Provider-query calls / 64 HTTP requests maximum), task-level `timeoutMs`, and per-result `queryOrigins`. Without a chat model, retrieval still runs and the summary stage is reported in `degradations`. If `summary.degraded` is `true`, the agent writes the synthesis from `results` and says the model was unavailable.

## Example: fetch-webpage

```bash
curl -sS "$SEARCH_HUB_URL/api/web/read" \
  -H "authorization: Bearer $SEARCH_HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.rfc-editor.org/rfc/rfc9110","maxContentChars":20000}'
```

The skill reads only the selected URL, never the whole result list. It reports `readStatus`, `reasonCode`, and `truncated`, and it does not launch Chromium. Browser rendering is not enabled in v0.1.18; `render=true` is rejected.

## Example: research-with-citations

Produces a table:

```markdown
| # | Source | Published | Found via | Retrieved |
|---|--------|-----------|-----------|-----------|
| 1 | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | 2022-06 | brave-eu, searxng-cn | 2026-11-13T04:00:00Z |
```

Rules enforced by the skill: one URL per row, verbatim titles, `unknown` instead of a guessed date, primary sources preferred, and an explicit “coverage incomplete” note when `status` is `partial`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` | Token missing, revoked, or expired | Issue a new token |
| `403 forbidden` | Token lacks the `search` scope | Recreate with the scope |
| `400 validation_error: No enabled search provider` | No provider enabled | Enable one in Sources |
| `503` with `failedSources` | All providers failed | Check provider health and keys |
| Skill not discovered | Wrong directory or missing frontmatter | Keep `name`/`description` and the exact folder name |
