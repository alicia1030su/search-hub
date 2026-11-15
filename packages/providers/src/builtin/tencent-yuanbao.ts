import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";
import { parseTencentCredential, tc3SignedHeaders } from "../tc3.js";

const DEFAULT_HOST = "wsa.tencentcloudapi.com";
const SERVICE = "wsa";
const ACTION = "SearchPro";
const VERSION = "2025-05-08";

/**
 * Tencent Yuanbao Search (元宝搜索) — TC3-HMAC-SHA256 signed Cloud API.
 *
 * Official doc: https://cloud.tencent.com/document/product/1806/121811
 * - `POST /` on `wsa.tencentcloudapi.com`, `X-TC-Action: SearchPro`,
 *   `X-TC-Version: 2025-05-08`.
 * - `Response.Pages` is an **array of JSON strings**, each of which must be
 *   parsed a second time. Fields inside: title, url, date, passage, content,
 *   site, score, authority_level, favicon, pics, deeplinks.
 * - `Cnt` only accepts 10/20/30/40/50; unsupported values are rounded up to the
 *   next documented bucket so a `limit=5` never becomes an invalid request.
 * - `Freshness` accepts `dN`/`mN`/`yN` or an explicit date range, not the
 *   generic day/week/month/year tokens; the mapping is explicit below.
 * - Credential is a **pair** (SecretId + SecretKey) stored as one JSON string,
 *   so the key scheduler rotates the pair atomically.
 */
const FRESHNESS_MAP: Record<string, string> = {
  day: "d1",
  week: "d7",
  month: "m1",
  year: "y1",
};

const CNT_BUCKETS = [10, 20, 30, 40, 50] as const;

function bucketCount(limit: number): number {
  const wanted = Math.max(1, Math.min(50, Math.trunc(limit)));
  return CNT_BUCKETS.find((value) => value >= wanted) ?? 50;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Documented example: "2025/02/26 09:37:00" — no timezone. Parsing it with
  // Date.parse would interpret it in the runner's local timezone, so the same
  // result would differ between a Beijing laptop and a UTC runner. The source
  // is a Chinese index, so pin it to +08:00 explicitly.
  const normalized = value.trim().replace(/\//g, "-");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized.replace(" ", "T")}+08:00`;
  const parsed = Date.parse(withZone);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

interface TencentPage {
  title?: unknown;
  url?: unknown;
  date?: unknown;
  passage?: unknown;
  content?: unknown;
  site?: unknown;
  score?: unknown;
}

/**
 * Tencent Cloud signs the `host` header, so the host must be exactly what the
 * request uses. A wrong host produces an AuthFailure from the service rather
 * than a clear local error, and a wrong port would silently sign the wrong host.
 *
 * Accepted:
 * - `https://wsa.tencentcloudapi.com` (default port 443), and
 * - `http://127.0.0.1:<port>` / `http://localhost:<port>` for a local TLS-
 *   terminating or test gateway. The signature is identical; only transport
 *   security differs, and this is an explicit, narrow exception.
 *
 * Rejected: any other scheme, userinfo, path/query/fragment, and https on a
 * non-443 port (the signed host would not match `host:443`).
 */
export function resolveTencentEndpoint(baseUrl: string | null | undefined): {
  url: string;
  host: string;
} {
  if (!baseUrl || !baseUrl.trim()) {
    return { url: `https://${DEFAULT_HOST}/`, host: DEFAULT_HOST };
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      "Tencent Base URL must be an absolute URL, e.g. https://wsa.tencentcloudapi.com",
    );
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      "Tencent Base URL must use https. A plain-http URL is accepted only for 127.0.0.1/localhost test gateways.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      "Tencent Base URL must not contain credentials.",
    );
  }
  if (parsed.protocol === "https:" && parsed.port && parsed.port !== "443") {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      `Tencent Base URL port ${parsed.port} is not supported; the signed host would not match the request.`,
    );
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      "Tencent Base URL must not contain a path, query or fragment; the API is served at /.",
    );
  }
  if (!parsed.hostname) {
    throw new ProviderError(
      "tencent-yuanbao",
      "tencent-yuanbao",
      "bad_request",
      "Tencent Base URL is missing a hostname.",
    );
  }
  const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  return { url: `${parsed.protocol}//${host}/`, host };
}

export const tencentYuanbaoAdapter: SearchProviderAdapter = {
  type: "tencent-yuanbao",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const credential = parseTencentCredential(ctx.apiKey);
    if (!credential) {
      throw new ProviderError(
        ctx.config.id,
        "tencent-yuanbao",
        "auth_invalid",
        "Tencent Yuanbao requires a SecretId + SecretKey credential pair (stored as one key).",
      );
    }

    // Preserve the configured scheme: tests and private deployments may point
    // at an HTTP gateway; production uses the official HTTPS host.
    const endpoint = resolveTencentEndpoint(ctx.config.baseUrl);
    const host = endpoint.host;
    // The web form submits select values as strings ("0"/"1"/"2"). Coercing
    // here keeps the adapter correct regardless of the transport, instead of
    // silently falling back to mode 0 and ignoring the user's choice.
    const modeRaw = ctx.config.config["mode"];
    const parsedMode =
      typeof modeRaw === "number"
        ? modeRaw
        : typeof modeRaw === "string" && modeRaw.trim() !== ""
          ? Number(modeRaw)
          : 0;
    const mode = [0, 1, 2].includes(parsedMode) ? parsedMode : 0;
    const site = ctx.config.config["site"];
    const industry = ctx.config.config["industry"];

    const payload: Record<string, unknown> = {
      Query: input.query,
      Mode: mode,
      Cnt: bucketCount(input.limit),
    };
    if (typeof site === "string" && site.trim()) payload["Site"] = site.trim();
    if (typeof industry === "string" && industry.trim()) payload["Industry"] = industry.trim();
    if (input.freshness && input.freshness !== "all") {
      const mapped = FRESHNESS_MAP[input.freshness];
      if (mapped) payload["Freshness"] = mapped;
    }

    const body = JSON.stringify(payload);
    const headers = tc3SignedHeaders({
      secretId: credential.secretId,
      secretKey: credential.secretKey,
      service: SERVICE,
      host,
      action: ACTION,
      version: VERSION,
      payload: body,
    });

    const response = await callJson(ctx, {
      url: endpoint.url,
      method: "POST",
      headers: {
        authorization: headers.authorization,
        "content-type": headers["content-type"],
        "x-tc-action": headers["x-tc-action"],
        "x-tc-timestamp": headers["x-tc-timestamp"],
        "x-tc-version": headers["x-tc-version"],
      },
      body,
    });

    const envelope = response.data as Record<string, unknown>;
    const payloadOut = envelope["Response"] as Record<string, unknown> | undefined;
    if (!payloadOut) {
      throw new ProviderError(
        ctx.config.id,
        "tencent-yuanbao",
        "bad_request",
        "Tencent Yuanbao response is missing the Response envelope.",
      );
    }
    const error = payloadOut["Error"] as Record<string, unknown> | undefined;
    if (error) {
      const message = String(error["Message"] ?? "Tencent Cloud returned an error");
      const code = String(error["Code"] ?? "");
      throw new ProviderError(
        ctx.config.id,
        "tencent-yuanbao",
        code.includes("AuthFailure") || code.includes("Unauthorized")
          ? "auth_invalid"
          : code.includes("RequestLimitExceeded")
            ? "rate_limited"
            : code.includes("ResourceNotFound") || code.includes("ResourceUnavailable")
              ? "quota_exceeded"
              : "bad_request",
        message,
        { details: { tencentCode: code } },
      );
    }

    const rawPages = Array.isArray(payloadOut["Pages"]) ? payloadOut["Pages"] : [];
    const results = rawPages
      .map((entry) => {
        if (typeof entry !== "string") return null;
        let page: TencentPage;
        try {
          page = JSON.parse(entry) as TencentPage;
        } catch {
          return null;
        }
        const mapped = mapItem(page, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["passage", "content"],
          scorePaths: ["score"],
        });
        if (!mapped) return null;
        const publishedAt = normalizeDate(page.date);
        const site = typeof page.site === "string" && page.site ? page.site : undefined;
        return {
          ...mapped,
          ...(publishedAt ? { publishedAt } : {}),
          ...(site ? { upstream: { providerName: site } } : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: endpoint.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await tencentYuanbaoAdapter.search(
        { query: "腾讯云", limit: 10, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Tencent Yuanbao returned ${results.length} result(s).`
            : "Tencent Yuanbao responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Tencent Yuanbao probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
