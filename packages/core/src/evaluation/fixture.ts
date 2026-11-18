import { normalizeUrl } from "@search-hub/shared";
import type {
  ProviderSnapshot,
  QualityDataset,
  QueryCategory,
  QueryJudgments,
  QuerySnapshot,
  RelevanceGrade,
} from "./types.js";

/**
 * The built-in offline fixture.
 *
 * Everything here is invented on purpose: the URLs live under
 * `*.fixture.test` so nobody can mistake them for a real vendor result, and the
 * dataset carries `origin: "synthetic_fixture"`. Its job is to prove the
 * metric engine, the fusion lab and the comparison logic behave correctly —
 * **never** to describe how good any real search engine is.
 *
 * The grades are written by hand, which is what makes them a qrel set rather
 * than a model's opinion of itself.
 */

interface FixtureDoc {
  url: string;
  title: string;
  /** Absent means "nobody judged this document". */
  grade?: RelevanceGrade;
}

interface FixtureQuery {
  query: string;
  category: QueryCategory;
  language: string;
  intent: string;
  docs: FixtureDoc[];
  /** Provider id -> indices into `docs`, best first. */
  orders: Record<string, number[]>;
}

const PROVIDERS = [
  { providerId: "alpha", providerName: "Alpha", providerType: "fixture" },
  { providerId: "beta", providerName: "Beta", providerType: "fixture" },
  { providerId: "gamma", providerName: "Gamma", providerType: "fixture" },
] as const;

function doc(url: string, title: string, grade?: RelevanceGrade): FixtureDoc {
  return { url, title, ...(grade === undefined ? {} : { grade }) };
}

const QUERIES: FixtureQuery[] = [
  {
    query: "typescript satisfies operator",
    category: "code",
    language: "en",
    intent: "Understand how the satisfies operator constrains an expression.",
    docs: [
      doc("https://www.fixture.test/ts/satisfies", "TypeScript 4.9: the satisfies operator", 3),
      doc("https://docs.fixture.test/ts/type-inference", "Type inference in TypeScript", 2),
      doc("https://blog.fixture.test/ts/satisfies-vs-as", "satisfies vs as in TypeScript", 2),
      doc("https://forum.fixture.test/ts/generics-thread", "Generic constraints discussion", 1),
      doc("https://shop.fixture.test/ts/posters", "TypeScript poster shop", 0),
    ],
    orders: { alpha: [0, 1, 3, 4], beta: [2, 0, 1, 4], gamma: [1, 2, 0, 3] },
  },
  {
    query: "vite config server proxy",
    category: "documentation",
    language: "en",
    intent: "Configure a development proxy in vite.config with server.proxy.",
    docs: [
      doc("https://docs.fixture.test/vite/server-options", "Vite server options: server.proxy", 3),
      doc("https://docs.fixture.test/vite/config-reference", "Vite config reference", 2),
      doc("https://blog.fixture.test/vite/proxy-cors", "Fixing CORS with a Vite dev proxy", 2),
      doc("https://forum.fixture.test/vite/proxy-404", "Dev proxy returns 404", 1),
      doc("https://news.fixture.test/vite/release", "Vite 8 release notes", 0),
    ],
    orders: { alpha: [1, 0, 4], beta: [0, 2, 1, 3], gamma: [2, 0, 3] },
  },
  {
    query: "capital of australia",
    category: "factual",
    language: "en",
    intent: "Find the capital city of Australia.",
    docs: [
      doc("https://geo.fixture.test/au/canberra", "Canberra is the capital of Australia", 3),
      doc("https://geo.fixture.test/au/cities", "List of cities in Australia", 1),
      doc("https://travel.fixture.test/au/sydney", "Sydney travel guide", 0),
      doc("https://geo.fixture.test/au/melbourne", "Melbourne travel guide", 0),
    ],
    orders: { alpha: [0, 1, 2, 3], beta: [2, 3, 0], gamma: [1, 0, 3] },
  },
  {
    query: "如何学习 rust 所有权",
    category: "chinese",
    language: "zh",
    intent: "找到系统讲解 Rust 所有权与借用规则的中文资料。",
    docs: [
      doc("https://docs.fixture.test/rust/ownership-zh", "Rust 所有权与借用：完整讲解", 3),
      doc("https://blog.fixture.test/rust/borrow-checker-zh", "读懂 Rust 借用检查器", 2),
      doc("https://forum.fixture.test/rust/ownership-question", "所有权相关提问汇总", 1),
      doc("https://news.fixture.test/rust/release-zh", "Rust 新版本发布说明", 0),
    ],
    orders: { alpha: [1, 0, 2], beta: [0, 1, 3], gamma: [2, 1, 0] },
  },
  {
    query: "what is reciprocal rank fusion",
    category: "english",
    language: "en",
    intent: "Understand the RRF formula and when it is used.",
    docs: [
      doc("https://papers.fixture.test/ir/rrf", "Reciprocal rank fusion outperforms condorcet", 3),
      doc("https://blog.fixture.test/ir/rrf-explained", "Reciprocal rank fusion explained", 3),
      doc("https://docs.fixture.test/ir/fusion-overview", "Overview of rank fusion methods", 2),
      doc("https://forum.fixture.test/ir/borda", "Borda count discussion", 1),
    ],
    orders: { alpha: [0, 2, 3], beta: [1, 2, 0], gamma: [2, 1, 3] },
  },
  {
    query: "BM25 versus dense retrieval",
    category: "academic",
    language: "en",
    intent: "Find evidence comparing lexical and dense retrieval quality.",
    docs: [
      doc("https://papers.fixture.test/ir/bm25-dense", "BM25 vs dense retrieval: a controlled comparison", 3),
      doc("https://papers.fixture.test/ir/dense-survey", "A survey of dense retrieval", 2),
      doc("https://blog.fixture.test/ir/hybrid", "Hybrid retrieval in practice", 2),
      doc("https://forum.fixture.test/ir/which-is-better", "Which retrieval method is better?", 1),
    ],
    orders: { alpha: [1, 0, 2], beta: [0, 2, 3], gamma: [2, 1, 0] },
  },
  {
    query: "2024 年诺贝尔物理学奖",
    category: "news",
    language: "zh",
    intent: "确认获奖者与获奖理由。",
    docs: [
      doc("https://news.fixture.test/nobel/2024-physics-zh", "2024 年诺贝尔物理学奖授予霍普菲尔德与欣顿", 3),
      doc("https://news.fixture.test/nobel/2024-summary-zh", "2024 年诺贝尔奖全部奖项汇总", 2),
      doc("https://blog.fixture.test/nobel/history-zh", "诺贝尔奖历史上的物理学奖", 1),
    ],
    orders: { alpha: [0, 1, 2], beta: [1, 0], gamma: [2, 0, 1] },
  },
  {
    query: "compare postgres and sqlite for embedded apps",
    category: "multi_hop",
    language: "en",
    intent: "Weigh SQLite against PostgreSQL for an embedded desktop application.",
    docs: [
      doc("https://docs.fixture.test/db/sqlite-when-to-use", "When to use SQLite", 3),
      doc("https://docs.fixture.test/db/postgres-concurrency", "PostgreSQL concurrency model", 2),
      doc("https://blog.fixture.test/db/embedded-db-comparison", "Comparing embedded database options", 3),
      doc("https://forum.fixture.test/db/sqlite-vs-postgres", "SQLite vs PostgreSQL thread", 2),
      doc("https://shop.fixture.test/db/books", "Database books", 0),
    ],
    orders: { alpha: [2, 0, 1, 4], beta: [0, 3, 1], gamma: [1, 2, 4] },
  },
  {
    query: "best noise cancelling headphones",
    category: "general",
    language: "en",
    intent: "Find buying advice with measurable noise reduction.",
    docs: [
      doc("https://reviews.fixture.test/audio/anc-roundup", "Noise cancelling headphones measured", 2),
      doc("https://reviews.fixture.test/audio/anc-cheap", "Budget ANC headphones tested", 2),
      doc("https://shop.fixture.test/audio/anc", "Shop: noise cancelling headphones", 0),
      doc("https://forum.fixture.test/audio/anc-thread", "ANC recommendation thread", 1),
    ],
    orders: { alpha: [2, 0, 1], beta: [1, 0, 3], gamma: [3, 1, 0] },
  },
  {
    query: "python asyncio task cancel",
    category: "code",
    language: "en",
    intent: "Cancel a task and handle CancelledError correctly.",
    docs: [
      doc("https://docs.fixture.test/python/asyncio-cancel", "asyncio.Task.cancel and CancelledError", 3),
      doc("https://docs.fixture.test/python/asyncio-tasks", "Coroutines and Tasks", 2),
      doc("https://blog.fixture.test/python/cancel-patterns", "Cancellation patterns in asyncio", 2),
      doc("https://forum.fixture.test/python/cancel-hang", "Task ignores cancellation", 1),
    ],
    orders: { alpha: [0, 1, 3], beta: [2, 0, 1], gamma: [1, 2, 3] },
  },
  {
    query: "docker compose healthcheck",
    category: "documentation",
    language: "en",
    intent: "Add a healthcheck to a compose service and gate dependents on it.",
    docs: [
      doc("https://docs.fixture.test/docker/compose-healthcheck", "Compose healthcheck reference", 3),
      doc("https://docs.fixture.test/docker/depends-on", "depends_on with condition", 2),
      doc("https://blog.fixture.test/docker/healthcheck-patterns", "Healthcheck patterns", 2),
      doc("https://news.fixture.test/docker/compose-release", "Compose release notes", 0),
    ],
    orders: { alpha: [2, 0, 1], beta: [0, 1, 3], gamma: [1, 2, 0] },
  },
  {
    query: "who invented the world wide web",
    category: "factual",
    language: "en",
    intent: "Identify the inventor and the year.",
    docs: [
      doc("https://history.fixture.test/web/tim-berners-lee", "Tim Berners-Lee and the World Wide Web", 3),
      doc("https://history.fixture.test/web/cern", "CERN and the first web server", 2),
      doc("https://history.fixture.test/web/arpanet", "ARPANET history", 0),
    ],
    orders: { alpha: [0, 1, 2], beta: [1, 0], gamma: [2, 0] },
  },
  {
    query: "北京到上海高铁多长时间",
    category: "chinese",
    language: "zh",
    intent: "查询京沪高铁的典型运行时间。",
    docs: [
      doc("https://travel.fixture.test/cn/beijing-shanghai-hsr", "京沪高铁时刻与运行时间", 3),
      doc("https://travel.fixture.test/cn/hsr-guide", "中国高铁乘坐指南", 1),
      doc("https://news.fixture.test/cn/hsr-news", "京沪高铁调图新闻", 2),
    ],
    orders: { alpha: [0, 2, 1], beta: [2, 0], gamma: [1, 0, 2] },
  },
  {
    query: "how to brew pour over coffee",
    category: "general",
    language: "en",
    intent: "A step-by-step pour-over recipe with ratios and timings.",
    docs: [
      doc("https://coffee.fixture.test/guides/pour-over", "Pour over coffee: a complete recipe", 3),
      doc("https://coffee.fixture.test/guides/grind-size", "Grind size for pour over", 2),
      doc("https://shop.fixture.test/coffee/drippers", "Coffee drippers for sale", 0),
      doc("https://forum.fixture.test/coffee/ratio-thread", "Water ratio discussion", 1),
    ],
    orders: { alpha: [1, 0, 2], beta: [0, 1, 3], gamma: [3, 0, 2] },
  },
];

const FIXTURE_CAPTURED_AT = "2026-11-01T00:00:00.000Z";

function slugFor(index: number): string {
  return `q${String(index + 1).padStart(2, "0")}`;
}

function buildSnapshots(queries: readonly FixtureQuery[]): QuerySnapshot[] {
  return queries.map((entry, index) => {
    const queryId = slugFor(index);
    const providers: ProviderSnapshot[] = PROVIDERS.map((provider) => {
      const order = entry.orders[provider.providerId];
      if (!order) {
        return { ...provider, results: [], ok: true, latencyMs: 40 };
      }
      const results = order
        .map((docIndex, position) => {
          const source = entry.docs[docIndex];
          if (!source) return null;
          return {
            documentId: normalizeUrl(source.url) ?? source.url,
            title: source.title,
            url: source.url,
            // Deterministic text, never generated prose that could be mistaken
            // for a real snippet.
            snippet: `${source.title} — fixture snippet.`,
            rank: position + 1,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      return { ...provider, results, ok: true, latencyMs: 40 + index * 3 };
    });
    return {
      queryId,
      query: entry.query,
      category: entry.category,
      providers,
      capturedAt: FIXTURE_CAPTURED_AT,
      upstreamRequests: providers.filter((provider) => provider.results.length > 0).length,
      cacheHits: 0,
    };
  });
}

export interface FixtureDataset {
  dataset: QualityDataset;
  queries: Array<{
    id: string;
    query: string;
    category: QueryCategory;
    language: string;
    intent: string;
  }>;
  judgments: Array<{ queryId: string; documentId: string; relevance: RelevanceGrade }>;
  snapshots: QuerySnapshot[];
}

const CORE_DATASET_ID = "ds_synthetic_core_v1";
const SHALLOW_DATASET_ID = "ds_synthetic_shallow_v1";

function buildDataset(input: {
  id: string;
  name: string;
  description: string;
  origin: "synthetic_fixture";
  judgmentsComplete: boolean;
}): QualityDataset {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    language: "mixed",
    version: 1,
    status: "frozen",
    origin: input.origin,
    judgmentsComplete: input.judgmentsComplete,
    createdAt: FIXTURE_CAPTURED_AT,
    updatedAt: FIXTURE_CAPTURED_AT,
    frozenAt: FIXTURE_CAPTURED_AT,
  };
}

/**
 * Complete fixture: every document any provider returned has a grade, so
 * recall is computable and no query is provisional.
 */
export function coreFixture(): FixtureDataset {
  const queries = QUERIES.map((entry, index) => ({
    id: slugFor(index),
    query: entry.query,
    category: entry.category,
    language: entry.language,
    intent: entry.intent,
  }));
  const judgments: FixtureDataset["judgments"] = [];
  QUERIES.forEach((entry, index) => {
    const queryId = slugFor(index);
    for (const source of entry.docs) {
      if (source.grade === undefined) continue;
      const documentId = normalizeUrl(source.url);
      if (!documentId) continue;
      judgments.push({ queryId, documentId, relevance: source.grade });
    }
  });

  return {
    dataset: buildDataset({
      id: CORE_DATASET_ID,
      name: "Synthetic core (offline fixture)",
      description:
        "Hand-labelled fixture used to test the evaluation machinery. Not a measurement of any vendor.",
      origin: "synthetic_fixture",
      judgmentsComplete: true,
    }),
    queries,
    judgments,
    snapshots: buildSnapshots(QUERIES),
  };
}

/**
 * Shallow fixture: only clearly relevant documents were judged, so unjudged
 * documents exist and recall must report N/A instead of a precise-looking
 * number computed from an incomplete ground truth.
 */
export function shallowFixture(): FixtureDataset {
  const core = coreFixture();
  const shallowQueries = new Set(["q01", "q03", "q05", "q07", "q10", "q13"]);
  // Query ids are globally unique in the database, so the shallow copy must not
  // reuse the core ids: two datasets share the same questions, not the same rows.
  const rename = (id: string) => `shallow_${id}`;
  return {
    dataset: buildDataset({
      id: SHALLOW_DATASET_ID,
      name: "Synthetic shallow (pooled judgments)",
      description:
        "Same fixture queries with positive-only judgments: demonstrates N/A recall and provisional metrics.",
      origin: "synthetic_fixture",
      judgmentsComplete: false,
    }),
    queries: core.queries
      .filter((entry) => shallowQueries.has(entry.id))
      .map((entry) => ({ ...entry, id: rename(entry.id) })),
    judgments: core.judgments
      .filter((entry) => shallowQueries.has(entry.queryId) && entry.relevance >= 2)
      .map((entry) => ({ ...entry, queryId: rename(entry.queryId) })),
    snapshots: core.snapshots
      .filter((entry) => shallowQueries.has(entry.queryId))
      .map((entry) => ({ ...entry, queryId: rename(entry.queryId) })),
  };
}

/** Converts stored judgments into the map shape the metric engine wants. */
export function judgmentsForQuery(
  queryId: string,
  rows: readonly { documentId: string; relevance: RelevanceGrade }[],
  judgmentsComplete: boolean,
): QueryJudgments {
  const grades = new Map<string, RelevanceGrade>();
  for (const row of rows) grades.set(row.documentId, row.relevance);
  const relevantTotal = judgmentsComplete
    ? [...grades.values()].filter((grade) => grade >= 2).length
    : null;
  return { queryId, grades, relevantTotal };
}

export const FIXTURE_DATASETS = { core: coreFixture, shallow: shallowFixture };
export const FIXTURE_QUERY_COUNT = QUERIES.length;
