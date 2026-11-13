#!/usr/bin/env node
/**
 * Multi-source search quality measurement (P1-2).
 *
 * Runs a FIXED, reproducible query set against a live Search Hub instance and
 * records numbers only. It never asks a model "does this look better" and it
 * never ranks one provider above another.
 *
 * For every query it does:
 *   1. one call per enabled provider  (providers: [id])   -> raw source behaviour
 *   2. one fused call over the real providers             -> aggregation behaviour
 *
 * Recorded per call: HTTP status, task status, request/success/failure counts,
 * failure codes, raw / de-duplicated / returned counts, valid absolute URLs
 * (^https?:// and not example.com), duplicate rate, server-side timing
 * (stats.timing.totalMs) and client wall time.
 *
 * Usage:
 *   node tests/scripts/search-quality.mjs --url http://127.0.0.1:8830 --token sh_xxx \
 *        [--out docs/search-quality-report.md] [--json-out docs/search-quality-report.json] \
 *        [--rerank-model <model-config-id>] [--limit 10] [--providers id1,id2]
 *
 * Exit codes:
 *   0  ran against at least one real (non-mock) provider and every fused query produced a usable result set
 *   2  configuration / authentication problem (token scope, unreachable instance)
 *   3  every enabled provider is `mock` — output is NOT real web-search evidence
 *   4  every fused query failed (upstream outage); the report is still written with the failure codes
 *   1  unexpected failure
 *
 * Requirements: Node >= 22 (global fetch). No external dependencies.
 */

const QUERIES = [
  {
    id: "zh-news",
    label: "中文时事",
    query: "国内 新能源汽车 出口 最新政策",
    note: "中文时政查询；对非中文索引的源天然不友好，仅记录数字。",
  },
  {
    id: "en-tech",
    label: "英文技术",
    query: "postgres logical replication lag",
    note: "英文技术主题，覆盖面广。",
  },
  {
    id: "exact-term",
    label: "精确关键词",
    query: '"Content-Security-Policy" connect-src',
    note: "带引号的精确短语，用于观察分词/短语匹配行为。",
  },
  {
    id: "fresh",
    label: "新近内容",
    query: "openai api changelog",
    freshness: "week",
    note: "带 freshness=week，仅近 7 天；不支持时间过滤的源会返回更旧内容。",
  },
];

const EXAMPLE_HOST = /(^|\.)example\.com$/i;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const baseUrl = arg("url", "http://127.0.0.1:8830").replace(/\/+$/, "");
const token = arg("token", process.env["SEARCH_HUB_TOKEN"] ?? "");
const outPath = arg("out", "docs/search-quality-report.md");
const jsonOutPath = arg("json-out", outPath.replace(/\.md$/i, "") + ".json");
const rerankModel = arg("rerank-model", "");
const limit = Number(arg("limit", "10"));
const providerFilter = (arg("providers", "") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function fail(code, message) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

if (!token) fail(2, "--token or SEARCH_HUB_TOKEN is required (needs the search and sources:read scopes)");
if (!Number.isFinite(limit) || limit < 1 || limit > 100) fail(2, "--limit must be between 1 and 100");

async function requestJson(path, init = {}) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      wallMs: Date.now() - started,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, wallMs: Date.now() - started, body };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Valid = absolute http(s) URL that is not a synthetic example.com placeholder. */
function isValidUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  return !EXAMPLE_HOST.test(hostOf(url));
}

function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const urls = list.map((item) => (typeof item?.url === "string" ? item.url : ""));
  const unique = new Set(urls.filter(Boolean));
  const valid = urls.filter(isValidUrl);
  const uniqueValid = new Set(valid);
  const withTitle = list.filter((item) => typeof item?.title === "string" && item.title.trim().length > 0);
  const withProvider = list.filter((item) => item?.provider && item?.providerName);
  const duplicateCount = urls.filter(Boolean).length - unique.size;
  return {
    returnedCount: list.length,
    urlCount: urls.filter(Boolean).length,
    uniqueUrlCount: unique.size,
    validUrlCount: valid.length,
    uniqueValidUrlCount: uniqueValid.size,
    exampleUrlCount: urls.filter((url) => /^https?:\/\//i.test(url) && EXAMPLE_HOST.test(hostOf(url))).length,
    duplicateUrlCount: duplicateCount,
    // Duplicate URLs among returned rows. The engine de-duplicates before
    // returning, so this is expected to be 0; a non-zero value is a defect.
    returnedDuplicateRate: urls.filter(Boolean).length === 0 ? 0 : duplicateCount / urls.filter(Boolean).length,
    titleCoverage: list.length === 0 ? 0 : withTitle.length / list.length,
    attributionCoverage: list.length === 0 ? 0 : withProvider.length / list.length,
  };
}

function failureCodes(body) {
  const codes = new Set();
  // Transport-level error envelope ({ error: { code } }): 400/401/403/503 before any search ran.
  const envelopeCode = body?.error?.code;
  if (typeof envelopeCode === "string" && envelopeCode.length > 0) codes.add(envelopeCode);
  const failed = Array.isArray(body?.failedSources) ? body.failedSources : [];
  for (const item of failed) {
    const code = typeof item?.code === "string" ? item.code : "unknown";
    codes.add(code);
  }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  for (const item of errors) {
    const code = typeof item?.code === "string" ? item.code : "unknown";
    codes.add(code);
  }
  const stats = Array.isArray(body?.stats?.providers) ? body.stats.providers : [];
  for (const item of stats) {
    if (item?.ok === false) codes.add(typeof item.errorCode === "string" ? item.errorCode : "unknown");
  }
  return [...codes].sort();
}

function providerStat(body, providerId) {
  const stats = Array.isArray(body?.stats?.providers) ? body.stats.providers : [];
  return stats.find((item) => item?.providerId === providerId) ?? null;
}

async function search(payload) {
  const response = await requestJson("/api/search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const body = response.body;
  const httpOk = response.ok;
  const taskStatus = typeof body?.status === "string" ? body.status : "http_error";
  return {
    httpStatus: response.status,
    httpOk,
    requestOk: httpOk && (taskStatus === "completed" || taskStatus === "partial"),
    taskStatus,
    wallMs: response.wallMs,
    serverMs: typeof body?.stats?.timing?.totalMs === "number" ? body.stats.timing.totalMs : null,
    partial: body?.stats?.partial === true,
    failedSources: Array.isArray(body?.failedSources) ? body.failedSources : [],
    errorCodes: failureCodes(body),
    rawCount: typeof body?.stats?.rawCount === "number" ? body.stats.rawCount : null,
    dedupedCount: typeof body?.stats?.dedupedCount === "number" ? body.stats.dedupedCount : null,
    fusedCount: typeof body?.stats?.fusedCount === "number" ? body.stats.fusedCount : null,
    degraded: body?.stats?.degraded === true,
    rerankApplied: body?.stats?.rerankApplied === true,
    rerankMs: typeof body?.stats?.timing?.rerankMs === "number" ? body.stats.timing.rerankMs : null,
    ...summarizeResults(body?.results),
    results: Array.isArray(body?.results) ? body.results : [],
    body,
    transportError: response.error ?? null,
  };
}

/** Raw duplicate rate = how many candidates de-duplication removed. */
function rawDuplicateRate(record) {
  if (record.rawCount === null || record.dedupedCount === null || record.rawCount <= 0) return null;
  return (record.rawCount - record.dedupedCount) / record.rawCount;
}

async function main() {
  // Provider inventory: the report must state exactly which sources produced
  // the numbers, and must refuse to call mock output "web search evidence".
  const providersResponse = await requestJson("/api/providers");
  if (providersResponse.status === 401 || providersResponse.status === 403) {
    fail(
      2,
      `GET /api/providers returned HTTP ${providersResponse.status}; the token needs the "sources:read" scope.`,
    );
  }
  if (!providersResponse.ok || !Array.isArray(providersResponse.body?.providers)) {
    fail(2, `cannot read provider inventory from ${baseUrl}/api/providers (HTTP ${providersResponse.status})`);
  }

  const allProviders = providersResponse.body.providers
    .filter((item) => item?.enabled === true)
    .map((item) => ({
      id: String(item.id),
      name: String(item.name),
      type: String(item.type),
      isMock: item.type === "mock",
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const selected = providerFilter.length > 0
    ? allProviders.filter((item) => providerFilter.includes(item.id) || providerFilter.includes(item.name))
    : allProviders;

  if (selected.length === 0) {
    fail(2, "no enabled provider matched; enable at least one source or check --providers");
  }

  const realProviders = selected.filter((item) => !item.isMock);
  const _mockProviders = selected.filter((item) => item.isMock);

  if (realProviders.length === 0) {
    console.log(
      "WARNING: only mock providers are enabled; results are not real web search evidence",
    );
    process.exit(3);
  }

  const providers = selected;
  const fusedProviderIds = realProviders.map((item) => item.id);
  const health = await requestJson("/api/health");

  const queryReports = [];
  const totals = {
    requests: 0,
    succeeded: 0,
    failed: 0,
    failureCodes: {},
  };
  function tally(record) {
    totals.requests += 1;
    if (record.requestOk) totals.succeeded += 1;
    else totals.failed += 1;
    for (const code of record.errorCodes) {
      totals.failureCodes[code] = (totals.failureCodes[code] ?? 0) + 1;
    }
  }

  for (const query of QUERIES) {
    const basePayload = {
      query: query.query,
      mode: "rrf",
      limit,
      skipCache: true,
      ...(query.freshness === undefined ? {} : { freshness: query.freshness }),
    };

    const perProvider = [];
    for (const provider of providers) {
      const record = await search({ ...basePayload, providers: [provider.id] });
      tally(record);
      const stat = providerStat(record.body, provider.id);
      perProvider.push({
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        isMock: provider.isMock,
        httpStatus: record.httpStatus,
        taskStatus: record.taskStatus,
        requestOk: record.requestOk,
        errorCodes: record.errorCodes,
        providerStat: stat === null
          ? null
          : {
              ok: stat.ok === true,
              resultCount: typeof stat.resultCount === "number" ? stat.resultCount : null,
              latencyMs: typeof stat.latencyMs === "number" ? stat.latencyMs : null,
              errorCode: typeof stat.errorCode === "string" ? stat.errorCode : null,
            },
        rawCount: record.rawCount,
        dedupedCount: record.dedupedCount,
        fusedCount: record.fusedCount,
        returnedCount: record.returnedCount,
        validUrlCount: record.validUrlCount,
        uniqueValidUrlCount: record.uniqueValidUrlCount,
        exampleUrlCount: record.exampleUrlCount,
        returnedDuplicateRate: record.returnedDuplicateRate,
        rawDuplicateRate: rawDuplicateRate(record),
        titleCoverage: record.titleCoverage,
        attributionCoverage: record.attributionCoverage,
        serverMs: record.serverMs,
        wallMs: record.wallMs,
        partial: record.partial,
        failedSources: record.failedSources,
        degraded: record.degraded,
        notes: record.transportError,
        topUrls: record.results.slice(0, 5).map((item) => item?.url ?? null),
      });
    }

    const fused = await search({ ...basePayload, providers: fusedProviderIds });
    tally(fused);

    let rerank = null;
    if (rerankModel) {
      const reranked = await search({
        ...basePayload,
        providers: fusedProviderIds,
        rerank: true,
        rerankModelId: rerankModel,
      });
      tally(reranked);
      const before = fused.results.slice(0, 5).map((item) => item?.url ?? null);
      const after = reranked.results.slice(0, 5).map((item) => item?.url ?? null);
      // A failed rerank call returns no results at all; comparing an empty list
      // against the baseline would report a meaningless "order changed".
      const comparable = reranked.requestOk && before.length > 0 && after.length > 0;
      const sameOrder = comparable && before.every((url, index) => url === after[index]);
      const beforeSet = new Set(before.filter(Boolean));
      const afterSet = new Set(after.filter(Boolean));
      rerank = {
        requestedModelId: rerankModel,
        httpStatus: reranked.httpStatus,
        taskStatus: reranked.taskStatus,
        requestOk: reranked.requestOk,
        errorCodes: reranked.errorCodes,
        rerankApplied: reranked.rerankApplied,
        degraded: reranked.degraded,
        rerankMs: reranked.rerankMs,
        returnedCount: reranked.returnedCount,
        validUrlCount: reranked.validUrlCount,
        top5Before: before,
        top5After: after,
        comparable,
        top5OrderChanged: comparable ? !sameOrder : null,
        top5SetChanged: comparable
          ? beforeSet.size !== afterSet.size || [...beforeSet].some((url) => !afterSet.has(url))
          : null,
      };
    }

    queryReports.push({
      ...query,
      perProvider,
      fused: {
        providerIds: fusedProviderIds,
        httpStatus: fused.httpStatus,
        taskStatus: fused.taskStatus,
        requestOk: fused.requestOk,
        errorCodes: fused.errorCodes,
        rawCount: fused.rawCount,
        dedupedCount: fused.dedupedCount,
        fusedCount: fused.fusedCount,
        returnedCount: fused.returnedCount,
        validUrlCount: fused.validUrlCount,
        uniqueValidUrlCount: fused.uniqueValidUrlCount,
        exampleUrlCount: fused.exampleUrlCount,
        returnedDuplicateRate: fused.returnedDuplicateRate,
        rawDuplicateRate: rawDuplicateRate(fused),
        titleCoverage: fused.titleCoverage,
        attributionCoverage: fused.attributionCoverage,
        serverMs: fused.serverMs,
        wallMs: fused.wallMs,
        partial: fused.partial,
        failedSources: fused.failedSources,
        degraded: fused.degraded,
        topUrls: fused.results.slice(0, 5).map((item) => item?.url ?? null),
      },
      rerank,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      baseUrl,
      version: health.body?.version ?? null,
      setupRequired: health.body?.setupRequired ?? null,
    },
    methodology: {
      mode: "rrf",
      limit,
      skipCache: true,
      queries: QUERIES.map((item) => ({ id: item.id, query: item.query, freshness: item.freshness ?? null })),
      perProviderCalls: providers.length,
      fusedCalls: 1,
      fusedProviderIds,
      rerankModel: rerankModel || null,
      validUrlRule: "matches ^https?:// and hostname is not example.com (or a subdomain of it)",
      duplicateRateRule:
        "returnedDuplicateRate = duplicate URLs among returned rows / returned URLs (0 expected, the engine de-duplicates); rawDuplicateRate = (rawCount - dedupedCount) / rawCount",
    },
    providers: providers.map((item) => ({ ...item })),
    totals,
    queries: queryReports,
  };

  // ---------------------------------------------------------------------------
  // Markdown
  // ---------------------------------------------------------------------------
  const pct = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const num = (value) => (value === null || value === undefined ? "n/a" : String(value));
  const esc = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [];

  lines.push("# Search Hub 多源搜索质量报告（数字口径）");
  lines.push("");
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`目标实例：\`${baseUrl}\`（version ${report.target.version ?? "n/a"}）`);
  lines.push("");
  lines.push("> 本报告只记录可复现的数字，不含主观质量评分，也不对任何 provider 排名或下「更好」的结论。");
  lines.push("> 数字含义受每个源的索引范围限制：Hacker News 是技术社区垂直搜索，不是通用网页搜索，中文时事覆盖差属预期。");
  lines.push("");

  lines.push("## 1. 环境与被测源");
  lines.push("");
  lines.push("| 源 ID | 名称 | 类型 | mock | 计入融合 |");
  lines.push("|---|---|---|---|---|");
  for (const provider of report.providers) {
    lines.push(
      `| ${esc(provider.id)} | ${esc(provider.name)} | ${esc(provider.type)} | ${provider.isMock ? "是" : "否"} | ${
        fusedProviderIds.includes(provider.id) ? "是" : "否"
      } |`,
    );
  }
  lines.push("");
  lines.push(
    `请求口径：每个 query 对 ${providers.length} 个源各 1 次单独调用 + 1 次融合调用；\`mode=rrf\`，\`limit=${limit}\`，\`skipCache=true\`（强制真实调用）。`,
  );
  lines.push("");

  lines.push("## 2. 请求汇总");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 总请求数 | ${totals.requests} |`);
  lines.push(`| 成功（completed/partial） | ${totals.succeeded} |`);
  lines.push(`| 失败 | ${totals.failed} |`);
  const failureEntries = Object.entries(totals.failureCodes).sort(([a], [b]) => a.localeCompare(b));
  lines.push(
    `| 失败码 | ${failureEntries.length === 0 ? "无" : failureEntries.map(([code, count]) => `${code}×${count}`).join("，")} |`,
  );
  lines.push("");

  lines.push("## 3. 逐 query 结果");
  lines.push("");
  for (const query of queryReports) {
    lines.push(`### ${query.id} — ${query.label}`);
    lines.push("");
    lines.push(`查询：\`${query.query}\`${query.freshness ? `，freshness=\`${query.freshness}\`` : ""}`);
    lines.push("");
    lines.push(query.note);
    lines.push("");
    lines.push("| 源 | 类型 | HTTP | 状态 | 原始条数 | 去重后 | 返回条数 | 有效 URL | 有效唯一 | 返回重复率 | 原始重复率 | 服务端 ms | 客户端 ms | 失败码 |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const item of query.perProvider) {
      lines.push(
        `| ${esc(item.providerName)} | ${esc(item.providerType)} | ${item.httpStatus} | ${esc(item.taskStatus)} | ${num(
          item.rawCount,
        )} | ${num(item.dedupedCount)} | ${item.returnedCount} | ${item.validUrlCount} | ${item.uniqueValidUrlCount} | ${pct(
          item.returnedDuplicateRate,
        )} | ${pct(item.rawDuplicateRate)} | ${num(item.serverMs)} | ${item.wallMs} | ${
          item.errorCodes.length === 0 ? "—" : esc(item.errorCodes.join(","))
        } |`,
      );
    }
    const fused = query.fused;
    lines.push(
      `| **全源融合** | — | ${fused.httpStatus} | ${esc(fused.taskStatus)} | ${num(fused.rawCount)} | ${num(
        fused.dedupedCount,
      )} | ${fused.returnedCount} | ${fused.validUrlCount} | ${fused.uniqueValidUrlCount} | ${pct(
        fused.returnedDuplicateRate,
      )} | ${pct(fused.rawDuplicateRate)} | ${num(fused.serverMs)} | ${fused.wallMs} | ${
        fused.errorCodes.length === 0 ? "—" : esc(fused.errorCodes.join(","))
      } |`,
    );
    lines.push("");
    lines.push(
      `融合状态：partial=${fused.partial ? "true" : "false"}，failedSources=${
        fused.failedSources.length === 0 ? "[]" : esc(JSON.stringify(fused.failedSources))
      }，degraded=${fused.degraded ? "true" : "false"}`,
    );
    if (fused.topUrls.length > 0) {
      lines.push("");
      lines.push("融合后前 5 条 URL（顺序即服务端排序）：");
      fused.topUrls.forEach((url, index) => lines.push(`${index + 1}. ${url ?? "(null)"}`));
    }
    if (query.rerank) {
      lines.push("");
      lines.push(
        `Rerank（\`${query.rerank.requestedModelId}\`）：http=${query.rerank.httpStatus}，applied=${
          query.rerank.rerankApplied ? "true" : "false"
        }，degraded=${query.rerank.degraded ? "true" : "false"}，rerankMs=${num(query.rerank.rerankMs)}，` +
          (query.rerank.comparable
            ? `top-5 顺序变化=${query.rerank.top5OrderChanged ? "是" : "否"}，top-5 集合变化=${query.rerank.top5SetChanged ? "是" : "否"}`
            : "top-5 对比=SKIPPED（rerank 调用未成功，无法比较排序）") +
          `${query.rerank.errorCodes.length > 0 ? `，失败码=${esc(query.rerank.errorCodes.join(","))}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 4. 逐源汇总（跨全部 query）");
  lines.push("");
  lines.push("| 源 | 请求 | 成功 | 失败 | 原始条数合计 | 去重后合计 | 返回条数合计 | 有效 URL 合计 | 平均服务端 ms | 平均客户端 ms | 失败码 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const provider of providers) {
    const rows = queryReports.map((query) => query.perProvider.find((item) => item.providerId === provider.id)).filter(Boolean);
    const sum = (pick) => rows.reduce((acc, item) => acc + (pick(item) ?? 0), 0);
    const avg = (pick) => {
      const values = rows.map(pick).filter((value) => typeof value === "number");
      return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    };
    const codes = new Set(rows.flatMap((item) => item.errorCodes));
    lines.push(
      `| ${esc(provider.name)} | ${rows.length} | ${rows.filter((item) => item.requestOk).length} | ${
        rows.filter((item) => !item.requestOk).length
      } | ${sum((item) => item.rawCount)} | ${sum((item) => item.dedupedCount)} | ${sum(
        (item) => item.returnedCount,
      )} | ${sum((item) => item.validUrlCount)} | ${num(avg((item) => item.serverMs))} | ${num(
        avg((item) => item.wallMs),
      )} | ${codes.size === 0 ? "—" : esc([...codes].join(","))} |`,
    );
    const examples = rows.reduce((acc, item) => acc + item.exampleUrlCount, 0);
    if (examples > 0) {
      lines.push(`| ↳ ${esc(provider.name)} 的 example.com 合成 URL |  |  |  |  |  |  | ${examples} |  |  |  |`);
    }
  }
  lines.push("");
  lines.push("## 5. 口径与限制");
  lines.push("");
  lines.push("- 有效 URL：形如 `^https?://` 且主机名不是 `example.com`（含子域）。Mock 源全部产出 `example.com` 合成 URL，不计为有效搜索结果。");
  lines.push("- 返回重复率：返回行中重复 URL / 返回 URL 总数。引擎在返回前已去重，正常应为 0；非 0 属缺陷。");
  lines.push("- 原始重复率：`(rawCount - dedupedCount) / rawCount`，反映该源自身返回的重复程度。");
  lines.push("- 延迟：服务端 `stats.timing.totalMs` 与客户端 wall time 都记录；两者差值为传输与 JSON 序列化开销。");
  lines.push("- 未做主观相关性评分：判断「哪条结果更相关」需要人工标注或外部标注集，本脚本不提供，也不以 LLM 自评代替。");
  lines.push("- 单一源的结果只能说明该源自身表现；不同源的索引范围不同（例如技术社区 vs 通用网页），横向比较条数没有质量含义。");
  lines.push("");
  lines.push("## 6. 如何读这份报告（必读）");
  lines.push("");
  lines.push("1. **条数不是质量分**。本报告没有相关性评测集，`returnedCount` / `validUrlCount` 只说明该源「返回了多少可用 URL」，不说明「这些 URL 有多相关」。");
  lines.push("2. **Hacker News 是技术社区垂直检索，不是通用网页搜索**。它对英文技术主题有覆盖，对中文时事（如 zh-news）通常返回 0 条——这是索引范围的必然结果，不是缺陷，也不能因此得出「某源更好 / 更差」的排名。");
  lines.push("3. **跨源条数不可比**。不同源的结果上限、去重策略、是否支持 `freshness` 都不同；只有在同一 query、同一 `limit`、同一时刻下的同一源自比才有意义。");
  lines.push(`4. **本轮参与统计的真实源只有 ${realProviders.length} 个**（${realProviders.map((item) => item.name).join("、") || "无"}）。样本量与源数量都不足以支撑任何「质量最好」的结论。`);
  lines.push("5. 需要「哪条更相关」的判断时，必须引入人工标注的相关性评测集（或外部 ground truth），本脚本不提供、也不冒充提供。");
  lines.push("");

  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const mdFile = resolve(process.cwd(), outPath);
  const jsonFile = resolve(process.cwd(), jsonOutPath);
  mkdirSync(dirname(mdFile), { recursive: true });
  mkdirSync(dirname(jsonFile), { recursive: true });
  writeFileSync(mdFile, `${lines.join("\n")}\n`, "utf8");
  writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`providers: ${providers.map((item) => `${item.name}(${item.type})`).join(", ")}`);
  console.log(`queries: ${QUERIES.length}  requests: ${totals.requests}  ok: ${totals.succeeded}  failed: ${totals.failed}`);
  for (const query of queryReports) {
    const fused = query.fused;
    console.log(
      `  ${query.id}: fused status=${fused.taskStatus} returned=${fused.returnedCount} validUrls=${fused.validUrlCount} ` +
        `server=${num(fused.serverMs)}ms wall=${fused.wallMs}ms partial=${fused.partial}`,
    );
  }
  console.log(`report: ${mdFile}`);
  console.log(`json:   ${jsonFile}`);
  if (totals.failed > 0) {
    console.log(`WARNING: ${totals.failed} of ${totals.requests} calls did not return a usable result set`);
  }
  // A report where every call failed is not evidence of anything, and a CI job
  // that reads only the exit code would call an outage a success. The report is
  // still written (so the failure codes are preserved), but the run fails.
  const fusedOk = queryReports.filter((query) => query.fused.requestOk).length;
  if (fusedOk === 0) {
    console.error(
      `FAIL: 0/${queryReports.length} fused calls returned a usable result set; ` +
        "this run is not search-quality evidence (see the failure codes above and in the JSON)",
    );
    process.exit(4);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`FAIL: ${error?.stack ?? error?.message ?? error}`);
  process.exit(1);
});
