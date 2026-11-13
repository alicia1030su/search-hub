# Model integration status (Chat / Embedding / Rerank)

Scope: what the model adapters actually implement, which evidence exists, and —
the part that matters — **what is still missing before any vendor can be called
`verified`**.

Read this together with `docs/testing.md` (§Models) and `docs/provider-matrix.md`.
The rule is the same for models and search providers: a local mock proves the
*protocol contract*, never the vendor.

## Verification levels

| Level | Meaning |
|---|---|
| `contract_tested` | The adapter is exercised end-to-end through a real Fastify app against a local HTTP fixture that speaks the vendor's documented wire format. Proves path, auth header, request body, response mapping, dimension checks, citation filtering and degradation. Does **not** prove account validity, rate limits, model behaviour or billing. |
| `live_verified` | A recorded run against the real vendor endpoint through this repository's adapter returned real data. Requires a credential *and* a recorded artifact (request id, response snippet, timestamp, who ran it). |
| `NOT VERIFIED — no credential` | Implemented and contract-tested, never executed against the vendor. This is the current state of **every** vendor below. |

No vendor in this repository is `live_verified`. There is no OpenAI, Anthropic,
Gemini, Cohere or Jina credential in the development environment, and no request
in this repository has ever been sent to those hosts. Anything that claims
otherwise is wrong.

## Status matrix

`apiKeyHint` is the only key material any API response may contain (last 4
characters). The plaintext key exists only in memory during a call.

| Kind | `providerType` | Protocol implemented | Endpoint the adapter calls | Auth header | Contract test | Real-vendor status | What is needed to become `live_verified` |
|---|---|---|---|---|---|---|---|
| chat | `openai-compatible` | OpenAI Chat Completions | `POST {baseUrl}/chat/completions` | `Authorization: Bearer <key>` | `tests/unit/models.test.ts`, `tests/integration/model-security.test.ts` | **NOT VERIFIED — no credential** | An OpenAI key + one recorded call returning a completion and `usage` |
| chat | `anthropic` | Anthropic Messages | `POST {baseUrl}/v1/messages` | `x-api-key: <key>`, `anthropic-version: 2023-06-01` | `tests/unit/models.test.ts` | **NOT VERIFIED — no credential** | An Anthropic key + a recorded call; confirm the system-prompt hoisting and `content[].text` extraction against a real response |
| chat | `gemini` | Gemini `generateContent` | `POST {baseUrl}/models/{modelId}:generateContent` | `x-goog-api-key: <key>` | `tests/integration/model-security.test.ts`, `tests/unit/models.test.ts` | **NOT VERIFIED — no credential** | A Google AI Studio key + a recorded call; confirm the base URL must end in `/v1beta` and that `usageMetadata` is populated |
| chat | `cohere` / `jina` / `custom-http` | **OpenAI Chat Completions shape** (fallback) | `POST {baseUrl}/chat/completions` | `Authorization: Bearer <key>` | not covered | **NOT VERIFIED — no credential / no such endpoint** | Only meaningful for a self-hosted gateway that speaks the OpenAI shape. Cohere's own chat API and Jina's API are *not* OpenAI-compatible; the request would 404. Use `openai-compatible` for gateways. |
| embedding | `openai-compatible` | OpenAI Embeddings (+ dimension validation, batching) | `POST {baseUrl}/embeddings` | `Authorization: Bearer <key>` | `tests/unit/models.test.ts`, `tests/integration/model-security.test.ts` | **NOT VERIFIED — no credential** | An OpenAI key + a recorded call; confirm the returned vector length matches the configured `dimensions` and therefore that the configured value is real |
| embedding | `jina` | OpenAI Embeddings shape | `POST {baseUrl}/embeddings` | `Authorization: Bearer <key>` | not covered | **NOT VERIFIED — no credential** | A Jina key + a recorded call. Jina's embeddings endpoint is documented as OpenAI-compatible, but that is a documentation claim, not evidence |
| embedding | `custom-http` | Declarative mapping (`params.path`, `inputField`, `itemsPath`, `vectorPath`) | `POST {baseUrl}{params.path ?? "/embeddings"}` | `Authorization: Bearer <key>` if a key is set | `tests/integration/model-security.test.ts` (nested `output.embeddings[].values`), `tests/unit/models.test.ts` | **NOT VERIFIED — no credential / no deployment** | A self-hosted endpoint (TEI, Ollama, vLLM…) plus a recorded call with the operator's mapping config |
| embedding | `anthropic` / `gemini` / `cohere` | **Not implemented for this kind** | falls back to `/embeddings` | `Authorization: Bearer` | not covered | **Not supported** | Nothing to verify: these vendors do not serve that endpoint. Configure them as `custom-http` once their native embedding API is implemented. |
| rerank | `cohere` | Cohere Rerank v2 | `POST {baseUrl}/v1/rerank` | `Authorization: Bearer <key>` | `tests/unit/models.test.ts`, `tests/integration/model-security.test.ts` | **NOT VERIFIED — no credential** | A Cohere key + a recorded call; confirm `relevance_score` is present (not only the reordered list) and that `return_documents:false` is accepted |
| rerank | `jina` | Cohere-compatible Rerank | `POST {baseUrl}/v1/rerank` | `Authorization: Bearer <key>` | `tests/unit/models.test.ts` | **NOT VERIFIED — no credential** | A Jina key + a recorded call. The shared contract is a documentation claim |
| rerank | `custom-http` | Declarative mapping (`path`, `resultsPath`, `indexPath`, `scorePath`, `documentField`, `queryField`) | `POST {baseUrl}{params.path ?? "/rerank"}` | `Authorization: Bearer <key>` if a key is set | `tests/integration/model-security.test.ts` (nested `payload.scores[].doc/prob`) | **NOT VERIFIED — no credential / no deployment** | A self-hosted reranker (TEI, vLLM, Infinity…) plus a recorded call with the operator's mapping config |
| rerank | `openai-compatible` / `anthropic` / `gemini` | **Not implemented for this kind** | falls back to Cohere-shaped `/v1/rerank` | `Authorization: Bearer` | not covered | **Not supported** | Nothing to verify: those vendors expose no rerank endpoint |

Two behaviours in this table are easy to get wrong, and the contract tests cover
both:

- **A key sent in a vendor-specific header must still be scrubbed.** Gemini uses
  `x-goog-api-key`, which the shared `redactSecrets` header list does not know
  about, so `packages/models/src/redact.ts` scrubs against the exact key the
  adapter was given before any error message leaves it. Without that, an
  upstream that echoes the header back would write the key into
  `model_configs.last_test_error` (and therefore into every `/api/admin/backup`
  snapshot) and into `stats.errors[].message` of a search response.
- **A dimension mismatch is a failure, not a silent truncation.** Vectors whose
  length differs from the configured `dimensions` are rejected and the embedding
  stage degrades, because mixing widths in a future index is unrecoverable.

## What the local fixtures prove (and do not prove)

`tests/integration/model-security.test.ts` stands up a local HTTP server that
impersonates a vendor. It proves:

- The request path and auth header per protocol (`/chat/completions`,
  `/v1/messages`, `/models/{id}:generateContent` with `x-goog-api-key`,
  `/embeddings`, `/v1/rerank`).
- Request-body shape: `model`, `messages[].role/content`, `input[]`,
  `documents[]`, `top_n`, `return_documents:false`.
- Response mapping: `choices[0].message.content`, `content[].type === "text"`,
  `candidates[0].content.parts[].text`, `data[].embedding` sorted by `index`,
  `results[].index/relevance_score`, and the index → URL mapping for rerank.
- Citation filtering: a `[9]` the model invents is dropped from
  `summary.citations` and never mapped onto a real result.
- Degradation: dimension mismatch, non-JSON rerank body, 401 and unreachable
  hosts all leave the fused results intact with `stats.degraded = true`.
- Security: model base URLs go through the same `SafeFetch` as provider traffic
  (SSRF policy, deployment proxy — a configured proxy receives the model
  request's `CONNECT`), the API key never appears in any response, export or
  snapshot, and `mode=basic` produces exactly zero model requests. Redirect and
  size-cap behaviour is shared code, proved separately in
  `tests/unit/safe-fetch.test.ts` and `tests/unit/proxy-ssrf.test.ts`.

It does **not** prove: that a key is valid, that a model name exists, that the
vendor's rate limits or error taxonomy match the mapping, that token counts are
accurate, that the summary is *good*, or that a real vendor tolerates the exact
header set. Only a recorded live run can prove those.

## How to promote a row to `live_verified`

For each vendor, in this order:

1. Provide the credential through the admin UI (`/models` → API key). Do not
   commit it and do not paste it into a test; tests must stay credential-free.
2. Press **Test** on the model row. It performs a real HTTP request through the
   same `SafeFetch` path as production and reports latency, plus the model's
   response (`usage`, dimensions or scored documents).
3. Record the evidence in this file: date (UTC), operator, vendor, model id,
   request id or response snippet that could only come from the vendor, and the
   measured latency.
4. Run a search with the corresponding mode and record that
   `stats.summaryApplied` / `embeddingApplied` / `rerankApplied` is `true` and
   that citations resolve to real result URLs.
5. Only then change the row's status to `live_verified`.

Steps 1–5 must be repeated per vendor and per kind. A verified Chat model says
nothing about the Embedding model from the same vendor.
