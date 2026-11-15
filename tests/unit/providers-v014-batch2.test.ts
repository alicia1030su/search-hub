import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import {
  anthropicWebSearchAdapter,
  crossrefAdapter,
  dataforseoAdapter,
  duckduckgoAdapter,
  europepmcAdapter,
  gdeltAdapter,
  genericMcpAdapter,
  jinaSearchAdapter,
  kakaoAdapter,
  linkupSearchAdapter,
  mistralWebSearchAdapter,
  naverAdapter,
  openaiWebSearchAdapter,
  openalexAdapter,
  parallelSearchAdapter,
  perplexitySearchAdapter,
  perplexitySonarAdapter,
  pubmedAdapter,
  searchapiAdapter,
  semanticscholarAdapter,
  serpapiAdapter,
  wikipediaAdapter,
  yandexAdapter,
  youcomAdapter,
} from "@search-hub/providers";

/**
 * Contract tests for the second provider batch.
 *
 * Fixtures mirror each vendor's published response shape. Every assertion is
 * about our parsing, not about the vendor being reachable: none of these has a
 * real credential, so all remain `documented`.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startServer(
  reply: (request: Captured, index: number) => { status?: number; body?: string; type?: string },
): Promise<{ baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const captured: Captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const out = reply(captured, requests.length - 1);
      res.writeHead(out.status ?? 200, { "content-type": out.type ?? "application/json" });
      res.end(out.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function ctxFor(
  type: string,
  baseUrl: string,
  options: {
    apiKey?: string;
    config?: Record<string, unknown>;
    search?: ProviderRuntimeConfig["search"];
  } = {},
): ProviderContext {
  const runtime: ProviderRuntimeConfig = {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl,
    timeoutMs: 5000,
    maxResults: 50,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: options.config ?? {},
    ...(options.search === undefined ? {} : { search: options.search }),
  };
  return {
    fetch: allowLocalFetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    config: runtime,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

describe("perplexity-search", () => {
  it("maps results[] and never turns an answer into a page", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        results: [
          { title: "A", url: "https://a.example/1", snippet: "s1", date: "2026-01-02" },
          { title: "B", url: "https://b.example/2", snippet: "s2" },
        ],
      }),
    }));
    const ctx = ctxFor("perplexity-search", baseUrl, { apiKey: "k", search: { targetResults: 2, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 2 } });
    const output = await perplexitySearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toBe("/search");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ query: "x", max_results: 2 });
    expect(output.results).toHaveLength(2);
    expect(output.results[0]!.publishedAt).toBe("2026-01-02");
    expect(output.answer).toBeUndefined();
  });

  it("clamps above the documented cap of 20", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ results: [] }) }));
    const ctx = ctxFor("perplexity-search", baseUrl, { apiKey: "k", search: { targetResults: 80, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 80 } });
    await perplexitySearchAdapter.search({ query: "x", limit: 80, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body).max_results).toBe(20);
  });
});

describe("youcom", () => {
  it("reads results.web[] only", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        results: {
          web: [{ title: "W", url: "https://w.example/1", description: "d", snippets: ["a", "b"] }],
          news: [{ title: "N", url: "https://n.example/2" }],
        },
      }),
    }));
    const ctx = ctxFor("youcom", baseUrl, { apiKey: "k" });
    const output = await youcomAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toContain("/v1/search?");
    expect(requests[0]!.headers["x-api-key"]).toBe("k");
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.url).toBe("https://w.example/1");
    // news[] must not leak into web results.
    expect(JSON.stringify(output.results)).not.toContain("n.example");
  });
});

describe("jina-search", () => {
  it("encodes the query into the path so it cannot change the endpoint", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ data: [{ title: "T", url: "https://t.example/1", description: "d" }] }),
    }));
    const ctx = ctxFor("jina-search", baseUrl, { apiKey: "k" });
    await jinaSearchAdapter.search({ query: "a/../b?x=1", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url.startsWith("/a%2F..%2Fb%3Fx%3D1")).toBe(true);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer k");
  });
});

describe("parallel-search", () => {
  it("sends objective plus search_queries and maps excerpts", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [{ title: "T", url: "https://t.example", excerpts: ["e1", "e2"] }] }),
    }));
    const ctx = ctxFor("parallel-search", baseUrl, { apiKey: "k" });
    const output = await parallelSearchAdapter.search({ query: "arch", limit: 5, signal: ctx.signal }, ctx);
    const body = JSON.parse(requests[0]!.body);
    expect(body.objective).toBe("arch");
    expect(body.search_queries).toEqual(["arch"]);
    expect(output.results[0]!.snippet).toBe("e1 e2");
  });
});

describe("linkup-search", () => {
  it("forces outputType=searchResults so no AI answer sneaks in", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [{ name: "T", url: "https://t.example", content: "c" }] }),
    }));
    const ctx = ctxFor("linkup-search", baseUrl, { apiKey: "k" });
    await linkupSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body).outputType).toBe("searchResults");
  });
});

describe("serpapi", () => {
  it("pages by start offset and keeps answer_box out of results", async () => {
    const { baseUrl, requests } = await startServer((_request, index) => ({
      body: JSON.stringify({
        organic_results: Array.from({ length: 2 }).map((_, i) => ({
          title: `R${index}-${i}`,
          link: `https://r.example/${index}-${i}`,
          snippet: "s",
          position: index * 2 + i + 1,
        })),
        answer_box: { title: "AB", link: "https://ab.example", snippet: "ans" },
      }),
    }));
    const ctx = ctxFor("serpapi", baseUrl, {
      apiKey: "k",
      search: { targetResults: 4, maxPages: 2, maxRequestsPerSearch: 2, pageSize: 2 },
    });
    const output = await serpapiAdapter.search({ query: "x", limit: 4, signal: ctx.signal }, ctx);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toContain("start=2");
    expect(output.results).toHaveLength(4);
    expect(output.results[0]!.upstreamRank).toBe(1);
    expect(JSON.stringify(output.results)).not.toContain("ab.example");
  });
});

describe("searchapi", () => {
  it("uses 1-based page numbers", async () => {
    const { baseUrl, requests } = await startServer((_request, index) => ({
      body: JSON.stringify({
        organic_results: Array.from({ length: 2 }).map((_, i) => ({
          title: `R${index}-${i}`,
          link: `https://r.example/${index}-${i}`,
          snippet: "s",
        })),
      }),
    }));
    const ctx = ctxFor("searchapi", baseUrl, {
      apiKey: "k",
      search: { targetResults: 4, maxPages: 2, maxRequestsPerSearch: 2, pageSize: 2 },
    });
    await searchapiAdapter.search({ query: "x", limit: 4, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toContain("page=1");
    expect(requests[1]!.url).toContain("page=2");
  });
});

describe("dataforseo", () => {
  it("builds Basic auth from login:password and reads organic items only", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        tasks: [
          {
            status_code: 20000,
            status_message: "Ok.",
            result: [
              {
                items: [
                  { type: "organic", rank_absolute: 1, title: "T", url: "https://t.example", description: "d" },
                  { type: "people_also_ask", title: "PAA", url: "" },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const ctx = ctxFor("dataforseo", baseUrl, { apiKey: "user:pass", search: { targetResults: 10, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 10 } });
    const output = await dataforseoAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const expected = `Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`;
    expect(requests[0]!.headers["authorization"]).toBe(expected);
    expect(Array.isArray(JSON.parse(requests[0]!.body))).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.upstreamRank).toBe(1);
  });

  it("requires a login:password pair", async () => {
    const ctx = ctxFor("dataforseo", "http://127.0.0.1:9", { apiKey: "nolon" });
    const error = await dataforseoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });

  it("maps a vendor task error to auth_invalid", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ tasks: [{ status_code: 40100, status_message: "Invalid credentials" }] }),
    }));
    const ctx = ctxFor("dataforseo", baseUrl, { apiKey: "user:pass" });
    const error = await dataforseoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });
});

describe("openai-websearch", () => {
  it("requires a web_search_call before claiming the tool ran", async () => {
    const withCall = {
      output: [
        { type: "web_search_call", action: { sources: [{ url: "https://a.example", title: "A" }] } },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "answer",
              annotations: [{ type: "url_citation", url: "https://a.example", title: "A" }],
            },
          ],
        },
      ],
    };
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify(withCall) }));
    const ctx = ctxFor("openai-websearch", baseUrl, { apiKey: "k", config: { model: "gpt-5" }, search: { targetResults: 5, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 5 } });
    const output = await openaiWebSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status).toMatchObject({ toolInvoked: true, hasVerifiableSources: true, answerSupported: true });
    expect(output.answer!.citations).toHaveLength(1);
    expect(output.results).toEqual([]);
  });

  it("reports toolInvoked=false when only a message comes back", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "no search" }] }] }),
    }));
    const ctx = ctxFor("openai-websearch", baseUrl, { apiKey: "k" });
    const output = await openaiWebSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status.toolInvoked).toBe(false);
    expect(output.warnings?.[0]).toContain("without a web_search_call");
  });
});

describe("anthropic-websearch", () => {
  it("sends the documented tool type and reads web_search_tool_result", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "x" } },
          {
            type: "web_search_tool_result",
            content: [{ type: "web_search_result", url: "https://a.example", title: "A", page_age: "2026-01-01" }],
          },
          { type: "text", text: "answer", citations: [{ url: "https://a.example", title: "A" }] },
        ],
      }),
    }));
    const ctx = ctxFor("anthropic-websearch", baseUrl, { apiKey: "k", search: { targetResults: 5, maxPages: 1, maxRequestsPerSearch: 3, pageSize: 5 } });
    const output = await anthropicWebSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.headers["x-api-key"]).toBe("k");
    expect(requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(requests[0]!.body);
    expect(body.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(output.answer!.status).toMatchObject({
      toolInvoked: true,
      retrievalSucceeded: true,
      hasVerifiableSources: true,
      answerSupported: true,
    });
    expect(output.answer!.citations).toHaveLength(1);
  });

  it("stays unknown without a server_tool_use block", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ content: [{ type: "text", text: "plain answer" }] }),
    }));
    const ctx = ctxFor("anthropic-websearch", baseUrl, { apiKey: "k" });
    const output = await anthropicWebSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status.toolInvoked).toBe("unknown");
  });
});

describe("mistral-websearch", () => {
  it("flattens chunked content and keeps toolInvoked unknown", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        outputs: [
          { type: "message.output", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
        ],
      }),
    }));
    const ctx = ctxFor("mistral-websearch", baseUrl, { apiKey: "k" });
    const output = await mistralWebSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.text).toBe("hello world");
    expect(output.answer!.status.toolInvoked).toBe("unknown");
    expect(output.answer!.status.answerSupported).toBe(false);
  });
});

describe("perplexity-sonar", () => {
  it("collects citations[] and search_results[] separately from the answer", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        choices: [{ message: { content: "Answer [1]" } }],
        citations: ["https://c1.example"],
        search_results: [{ title: "S", url: "https://s1.example", date: "2026-02-02" }],
      }),
    }));
    const ctx = ctxFor("perplexity-sonar", baseUrl, { apiKey: "k" });
    const output = await perplexitySonarAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.citations.map((item) => item.url)).toEqual(["https://s1.example", "https://c1.example"]);
    expect(output.answer!.status).toMatchObject({ toolInvoked: true, hasVerifiableSources: true, answerSupported: true });
    expect(output.results).toEqual([]);
  });
});

describe("naver", () => {
  it("splits the credential pair and strips highlight tags", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ items: [{ title: "<b>검색</b>", link: "https://n.example/1", description: "<b>d</b>" }] }),
    }));
    const ctx = ctxFor("naver", baseUrl, { apiKey: "id:secret", search: { targetResults: 1, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 1 } });
    const output = await naverAdapter.search({ query: "검색", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.headers["x-naver-client-id"]).toBe("id");
    expect(requests[0]!.headers["x-naver-client-secret"]).toBe("secret");
    expect(output.results[0]!.title).toBe("검색");
    expect(output.results[0]!.snippet).toBe("d");
    expect(output.results[0]!.language).toBe("ko");
  });
});

describe("kakao", () => {
  it("uses the KakaoAK scheme and honours meta.is_end", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        documents: [{ title: "<b>t</b>", url: "https://k.example/1", contents: "c" }],
        meta: { is_end: true },
      }),
    }));
    const ctx = ctxFor("kakao", baseUrl, { apiKey: "rest", search: { targetResults: 10, maxPages: 3, maxRequestsPerSearch: 3, pageSize: 50 } });
    const output = await kakaoAdapter.search({ query: "x", limit: 10, signal: ctx.signal }, ctx);
    expect(requests[0]!.headers["authorization"]).toBe("KakaoAK rest");
    expect(output.results).toHaveLength(1);
    expect(output.warnings?.[0]).toContain("is_end");
  });
});

describe("yandex", () => {
  it("posts the documented nested body and joins passages", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        query: { search_web: { results: [{ title: "T", url: "https://y.example/1", passages: [{ text: "a" }, { text: "b" }] }] } },
      }),
    }));
    const ctx = ctxFor("yandex", baseUrl, { apiKey: "k", search: { targetResults: 5, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 10 } });
    const output = await yandexAdapter.search({ query: "поиск", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.headers["authorization"]).toBe("Api-Key k");
    const body = JSON.parse(requests[0]!.body);
    // The adapter asks for a full page (10), not for the remaining target (5).
    expect(body.query.search_web).toMatchObject({ query_text: "поиск", page: 0, docs_on_page: 10 });
    expect(output.results[0]!.snippet).toBe("a b");
  });
});

describe("wikipedia", () => {
  it("builds curid URLs and sends a descriptive user-agent", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ query: { search: [{ title: "Article", pageid: 42, snippet: "<span>x</span>d" }] } }),
    }));
    const ctx = ctxFor("wikipedia", baseUrl, { config: { language: "en" } });
    const output = await wikipediaAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toContain("list=search");
    expect(requests[0]!.headers["user-agent"]).toContain("SearchHub");
    expect(output.results[0]!.url).toBe(`${baseUrl}/?curid=42`);
    expect(output.warnings?.[0]).toContain("encyclopaedia");
  });
});

describe("crossref", () => {
  it("falls back to doi.org when a work has no URL", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        message: {
          items: [
            { title: ["Paper"], DOI: "10.1/x", published: { "date-parts": [[2024, 5, 6]] } },
            { title: ["No title"], URL: "https://cr.example/2" },
          ],
        },
      }),
    }));
    const ctx = ctxFor("crossref", baseUrl, { config: { mailto: "a@b.c" } });
    const output = await crossrefAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toContain("mailto=a%40b.c");
    expect(output.results[0]!.url).toBe("https://doi.org/10.1/x");
    expect(output.results[0]!.publishedAt).toBe("2024-05-06");
  });
});

describe("openalex", () => {
  it("reconstructs the inverted abstract index into text", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        results: [
          {
            title: "T",
            primary_location: { landing_page_url: "https://oa.example/1" },
            abstract_inverted_index: { Hello: [0], world: [1] },
          },
        ],
      }),
    }));
    const ctx = ctxFor("openalex", baseUrl);
    const output = await openalexAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    // The raw index must never appear as a snippet.
    expect(output.results[0]!.snippet).toBe("Hello world");
  });
});

describe("pubmed", () => {
  it("runs esearch then esummary and builds pubmed URLs", async () => {
    const { baseUrl, requests } = await startServer((request) => {
      if (request.url.includes("esearch")) {
        return { body: JSON.stringify({ esearchresult: { idlist: ["111", "222"] } }) };
      }
      return {
        body: JSON.stringify({
          result: {
            uids: ["111", "222"],
            "111": { title: "T1", source: "J1", pubdate: "2024 Jan", authors: [{ name: "A" }] },
            "222": { title: "T2", source: "J2" },
          },
        }),
      };
    });
    const ctx = ctxFor("pubmed", baseUrl);
    const output = await pubmedAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests).toHaveLength(2);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]!.url).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(output.results[0]!.snippet).toContain("J1");
  });

  it("returns zero results when esearch finds nothing", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ esearchresult: { idlist: [] } }),
    }));
    const ctx = ctxFor("pubmed", baseUrl);
    const output = await pubmedAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests).toHaveLength(1);
    expect(output.results).toEqual([]);
  });
});

describe("semanticscholar", () => {
  it("falls back to the paper page when url is missing", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ data: [{ paperId: "abc", title: "T", abstract: "A", year: 2024 }] }),
    }));
    const ctx = ctxFor("semanticscholar", baseUrl, { apiKey: "k" });
    const output = await semanticscholarAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results[0]!.url).toBe("https://www.semanticscholar.org/paper/abc");
    expect(output.results[0]!.publishedAt).toBe("2024");
  });
});

describe("europepmc", () => {
  it("builds source/id article URLs", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ resultList: { result: [{ id: "9", source: "MED", title: "T", journalTitle: "J" }] } }),
    }));
    const ctx = ctxFor("europepmc", baseUrl);
    const output = await europepmcAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results[0]!.url).toBe("https://europepmc.org/article/MED/9");
  });
});

describe("gdelt", () => {
  it("converts the compact seendate to ISO and handles an empty body", async () => {
    const { baseUrl } = await startServer((_request, index) =>
      index === 0
        ? {
            body: JSON.stringify({
              articles: [{ url: "https://g.example/1", title: "T", seendate: "20260322T101500Z", domain: "g.example" }],
            }),
          }
        : { body: "" },
    );
    const ctx = ctxFor("gdelt", baseUrl);
    const output = await gdeltAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results[0]!.publishedAt).toBe("2026-03-22T10:15:00Z");
  });
});

describe("generic-mcp", () => {
  it("negotiates a session, discovers a search tool and maps the payload", async () => {
    const { baseUrl, requests } = await startServer((request) => {
      const body = request.body ? JSON.parse(request.body) : {};
      if (body.method === "initialize") {
        return {
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
          // The session header is what makes Streamable HTTP stateful.
        };
      }
      if (body.method === "notifications/initialized") {
        return { status: 202, body: "" };
      }
      if (body.method === "tools/list") {
        return {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "web_search", inputSchema: { type: "object" } }] },
          }),
        };
      }
      return {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: { results: [{ title: "T", url: "https://m.example/1", snippet: "s" }] } },
        }),
      };
    });
    const ctx = ctxFor("generic-mcp", baseUrl, { apiKey: "k", config: {} });
    const output = await genericMcpAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);

    // initialize -> initialized -> tools/list -> tools/call
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.url).toBe("https://m.example/1");
    // A bearer header is built from the encrypted key.
    expect(requests[0]!.headers["authorization"]).toBe("Bearer k");
  });

  it("refuses a stdio-looking endpoint", async () => {
    const ctx = ctxFor("generic-mcp", "stdio://local", {});
    const error = await genericMcpAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });

  it("reports each tool name when no search-like tool exists", async () => {
    const { baseUrl } = await startServer((request) => {
      const body = request.body ? JSON.parse(request.body) : {};
      if (body.method === "notifications/initialized") return { status: 202, body: "" };
      if (body.method === "tools/list") {
        return {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "send_email" }, { name: "delete_file" }] },
          }),
        };
      }
      return { body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }) };
    });
    const ctx = ctxFor("generic-mcp", baseUrl, {});
    const error = await genericMcpAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
    expect((error as Error).message).toContain("send_email");
  });
});

describe("duckduckgo", () => {
  it("returns instant-answer links and says it is not web search", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        Heading: "Search engine",
        AbstractText: "A search engine is a system.",
        AbstractURL: "https://en.wikipedia.org/wiki/Search_engine",
        RelatedTopics: [
          { Text: "Web search engine", FirstURL: "https://ddg.example/1" },
          { Topics: [{ Text: "Nested", FirstURL: "https://ddg.example/2" }] },
        ],
      }),
    }));
    const ctx = ctxFor("duckduckgo", baseUrl);
    const output = await duckduckgoAdapter.search({ query: "search engine", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results.map((item) => item.url)).toEqual([
      "https://en.wikipedia.org/wiki/Search_engine",
      "https://ddg.example/1",
      "https://ddg.example/2",
    ]);
    expect(output.warnings?.[0]).toContain("instant answers");
  });
});
