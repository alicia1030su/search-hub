import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject } from "../http.js";

const DEFAULT_BASE_URL = "https://eutils.ncbi.nlm.nih.gov";

/**
 * PubMed (NCBI E-utilities) — biomedical literature.
 *
 * Contract (from the published NCBI E-utilities docs):
 * - Step 1: `GET {baseUrl}/entrez/eutils/esearch.fcgi?db=pubmed&term=…&retmode=json&retmax=…&sort=relevance`
 *   → `esearchresult.idlist[]`.
 * - Step 2: `GET {baseUrl}/entrez/eutils/esummary.fcgi?db=pubmed&id=1,2,3&retmode=json`
 *   → `result[uids[i]]` with `title`, `pubdate`, `source`, `authors[]`,
 *   `elocationid`.
 * - Article URL: `https://pubmed.ncbi.nlm.nih.gov/{pmid}/`.
 * - No authentication. NCBI asks for at most 3 requests/second and a
 *   `tool`/`email` identification; this adapter makes exactly two requests per
 *   search and identifies itself.
 *
 * Verification: `documented` and **live-tested** against the public API.
 */
interface ESummaryDoc {
  title?: unknown;
  pubdate?: unknown;
  source?: unknown;
  authors?: Array<{ name?: unknown }>;
  elocationid?: unknown;
}

export const pubmedAdapter: SearchProviderAdapter = {
  type: "pubmed",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const retmax = Math.max(1, Math.min(100, Math.trunc(search?.targetResults ?? input.limit)));
    const tool = (ctx.config.config["tool"] as string | undefined) ?? "search-hub";
    const email = (ctx.config.config["email"] as string | undefined) ?? "";

    const esearch = new URL(`${baseUrl}/entrez/eutils/esearch.fcgi`);
    esearch.searchParams.set("db", "pubmed");
    esearch.searchParams.set("term", input.query);
    esearch.searchParams.set("retmode", "json");
    esearch.searchParams.set("retmax", String(retmax));
    esearch.searchParams.set("sort", "relevance");
    esearch.searchParams.set("tool", tool);
    if (email) esearch.searchParams.set("email", email);

    const searchResponse = await callJson(ctx, { url: esearch.toString(), method: "GET" });
    const payload = expectObject(ctx, searchResponse.data, "PubMed esearch response");
    const searchResult = expectObject(ctx, payload["esearchresult"], "PubMed esearchresult");
    const idlist = expectArray(ctx, searchResult["idlist"], "PubMed idlist")
      .filter((id): id is string => typeof id === "string");
    if (idlist.length === 0) {
      return { results: [], requestUrl: esearch.toString() };
    }

    const esummary = new URL(`${baseUrl}/entrez/eutils/esummary.fcgi`);
    esummary.searchParams.set("db", "pubmed");
    esummary.searchParams.set("id", idlist.slice(0, retmax).join(","));
    esummary.searchParams.set("retmode", "json");
    esummary.searchParams.set("tool", tool);
    if (email) esummary.searchParams.set("email", email);

    const summaryResponse = await callJson(ctx, { url: esummary.toString(), method: "GET" });
    const summary = expectObject(ctx, summaryResponse.data, "PubMed esummary response");
    const resultBlock = expectObject(ctx, summary["result"], "PubMed result");
    const uids = expectArray(ctx, resultBlock["uids"], "PubMed uids")
      .filter((id): id is string => typeof id === "string");

    const results: RawSearchResult[] = [];
    for (const pmid of uids) {
      const doc = resultBlock[pmid] as ESummaryDoc | undefined;
      if (!doc) continue;
      const title = typeof doc.title === "string" ? doc.title.replace(/<[^>]+>/g, "").trim() : "";
      if (!title) continue;
      const authors = Array.isArray(doc.authors)
        ? doc.authors
            .map((author) => (typeof author.name === "string" ? author.name : ""))
            .filter(Boolean)
            .slice(0, 3)
            .join(", ")
        : "";
      const journal = typeof doc.source === "string" ? doc.source : "";
      results.push({
        title,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        snippet: [journal, authors].filter(Boolean).join(" · ").slice(0, 600),
        ...(typeof doc.pubdate === "string" ? { publishedAt: doc.pubdate } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: esearch.toString(),
      warnings: ["PubMed indexes biomedical literature, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await pubmedAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `PubMed returned ${results.length} citation(s).` : "PubMed returned no citations.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `PubMed probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as PUBMED_DEFAULT_BASE_URL };
