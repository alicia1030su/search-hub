import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { SearchHubError } from "./errors.js";
import type { SafeFetch, SafeFetchResponse } from "./types.js";

export interface SsrfPolicy {
  /** Exact hostnames or suffix patterns beginning with a dot (".internal"). */
  allowPrivateHosts: string[];
  maxRedirects: number;
  /** Default true so self-hosted SearXNG over http keeps working. */
  allowHttp: boolean;
}

export const DEFAULT_SSRF_POLICY: SsrfPolicy = {
  allowPrivateHosts: [],
  maxRedirects: 3,
  allowHttp: true,
};

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_METADATA = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Normalizes IPv4-mapped IPv6 (::ffff:127.0.0.1) to plain IPv4. */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:") && lower.includes(".")) return lower.slice(7);
  return lower;
}

export function isBlockedAddress(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  if (BLOCKED_METADATA.has(ip)) return true;

  const version = isIP(ip);
  if (version === 4) {
    return BLOCKED_V4.some(([base, bits]) => inV4Cidr(ip, base, bits));
  }
  if (version === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
      return true; // fe80::/10
    }
    if (ip.startsWith("ff")) return true; // multicast
    if (ip.startsWith("2001:db8:")) return true; // documentation
    if (ip.startsWith("64:ff9b:")) return true; // NAT64 translation of private v4
    return false;
  }
  return true;
}

export function hostIsAllowlisted(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    const pattern = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!pattern) return false;
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
    if (pattern.startsWith(".")) return host === pattern.slice(1) || host.endsWith(pattern);
    return host === pattern;
  });
}

export interface ValidatedTarget {
  url: URL;
  addresses: string[];
  allowlisted: boolean;
}

export async function validateOutboundUrl(
  rawUrl: string,
  policy: SsrfPolicy = DEFAULT_SSRF_POLICY,
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SearchHubError("bad_request", `Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SearchHubError("blocked", `Blocked URL protocol: ${url.protocol}`);
  }
  if (url.protocol === "http:" && !policy.allowHttp) {
    throw new SearchHubError("blocked", "Plain HTTP destinations are disabled by policy");
  }
  if (url.username || url.password) {
    throw new SearchHubError("blocked", "URLs with embedded credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) throw new SearchHubError("blocked", "URL has no hostname");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    if (!hostIsAllowlisted(hostname, policy.allowPrivateHosts)) {
      throw new SearchHubError("blocked", `Blocked internal hostname: ${hostname}`);
    }
  }

  const allowlisted = hostIsAllowlisted(hostname, policy.allowPrivateHosts);
  const literalFamily = isIP(hostname);
  const addresses: string[] = [];

  if (literalFamily !== 0) {
    addresses.push(hostname);
  } else {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new SearchHubError("network", `DNS resolution failed for ${hostname}`, {
        cause: error,
        retryable: true,
      });
    }
    if (resolved.length === 0) {
      throw new SearchHubError("network", `DNS returned no addresses for ${hostname}`);
    }
    addresses.push(...resolved.map((item) => item.address));
  }

  // Cloud metadata endpoints are never allowed, even with an allowlist entry.
  if (addresses.some((address) => BLOCKED_METADATA.has(normalizeIp(address)))) {
    throw new SearchHubError("blocked", "Destination resolves to a cloud metadata address");
  }

  if (!allowlisted) {
    const blocked = addresses.find((address) => isBlockedAddress(address));
    if (blocked) {
      throw new SearchHubError(
        "blocked",
        `Destination ${hostname} resolves to a private or reserved address (${blocked}). ` +
          "Add it to the private host allowlist in Settings if this is intentional.",
      );
    }
  }

  return { url, addresses, allowlisted };
}

/**
 * Connect-time DNS guard. Even if an attacker changes the DNS answer between
 * validation and connection, the socket can only reach an approved address.
 */
export function createGuardedDispatcher(policy: SsrfPolicy = DEFAULT_SSRF_POLICY): Dispatcher {
  // Node's net.connect calls lookup with `all: true` when autoSelectFamily is
  // enabled (the default on Node 20+). Returning a single address in that mode
  // crashes with ERR_INVALID_IP_ADDRESS, so the callback shape must follow the
  // requested option.
  const lookup: typeof import("node:dns").lookup = ((
    hostname: string,
    options: Record<string, unknown>,
    callback: (...args: unknown[]) => void,
  ) => {
    const allowlisted = hostIsAllowlisted(hostname, policy.allowPrivateHosts);
    dnsLookup(hostname, { all: true, verbatim: true })
      .then((addresses) => {
        const usable = allowlisted
          ? addresses
          : addresses.filter((item) => !isBlockedAddress(item.address));
        if (usable.length === 0) {
          const error: NodeJS.ErrnoException = new Error(
            `SSRF guard blocked connection to ${hostname}`,
          );
          error.code = "ERR_SSRF_BLOCKED";
          callback(error);
          return;
        }
        if (options["all"]) {
          callback(null, usable.map((item) => ({ address: item.address, family: item.family })));
          return;
        }
        const family = Number(options["family"] ?? 0);
        const chosen = usable.find((item) => family === 0 || item.family === family) ?? usable[0]!;
        callback(null, chosen.address, chosen.family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error));
  }) as unknown as typeof import("node:dns").lookup;

  return new Agent({
    connect: {
      lookup,
    },
  });
}

export interface SafeFetchOptions {
  policy?: SsrfPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  /** Optional fixed headers, for example User-Agent. */
  defaultHeaders?: Record<string, string>;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new SearchHubError("blocked", `Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * JSON fetch with SSRF protection, manual redirects, size caps and timeouts.
 * All outbound provider/model traffic must go through this function.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const policy = options.policy ?? DEFAULT_SSRF_POLICY;
  const defaultTimeout = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const dispatcher = createGuardedDispatcher(policy);

  return async function safeFetch<T = unknown>(
    rawUrl: string,
    init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<SafeFetchResponse<T>> {
    let currentUrl = rawUrl;
    const timeoutMs = init.timeoutMs ?? defaultTimeout;
    const limit = init.maxBytes ?? maxBytes;

    for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
      await validateOutboundUrl(currentUrl, policy);

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(new Error("timeout")), timeoutMs);
      const signals: AbortSignal[] = [timeoutController.signal];
      if (init.signal) signals.push(init.signal);
      const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

      const headers = new Headers(
        init.headers as ConstructorParameters<typeof Headers>[0] | undefined,
      );
      if (!headers.has("user-agent")) {
        headers.set("user-agent", "SearchHub/0.1 (+https://github.com/search-hub/search-hub)");
      }
      for (const [key, value] of Object.entries(options.defaultHeaders ?? {})) {
        if (!headers.has(key)) headers.set(key, value);
      }

      let response: Response;
      try {
        // undici ships its own DOM type declarations; cast to the Node global
        // Response so this module has a single public type surface.
        response = (await undiciFetch(currentUrl, {
          ...init,
          headers,
          redirect: "manual",
          signal,
          dispatcher,
        } as never)) as unknown as Response;
      } catch (error) {
        if (timeoutController.signal.aborted) {
          throw new SearchHubError("timeout", `Request timed out after ${timeoutMs}ms`, {
            cause: error,
            retryable: true,
            status: 504,
          });
        }
        if (error instanceof SearchHubError) throw error;
        throw new SearchHubError("network", `Network error requesting ${currentUrl}`, {
          cause: error,
          retryable: true,
          status: 502,
        });
      } finally {
        clearTimeout(timer);
      }

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) {
          throw new SearchHubError("bad_request", "Redirect response without a Location header");
        }
        if (hop === policy.maxRedirects) {
          throw new SearchHubError("blocked", "Too many redirects");
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const body = await readLimitedBody(response, limit);
      const contentType = response.headers.get("content-type") ?? "";
      let data: unknown = body;
      if (body && (contentType.includes("json") || body.trimStart().startsWith("{"))) {
        try {
          data = JSON.parse(body);
        } catch {
          data = body;
        }
      }

      if (!response.ok) {
        const message =
          typeof data === "object" && data !== null
            ? extractErrorMessage(data)
            : body.slice(0, 300);
        throw new SearchHubError("bad_request", `Upstream returned HTTP ${response.status}${message ? `: ${message}` : ""}`, {
          status: response.status,
          details: { upstreamStatus: response.status, url: currentUrl },
          retryable: response.status >= 500 || response.status === 429,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        });
      }

      return {
        status: response.status,
        headers: response.headers,
        data: data as T,
        url: currentUrl,
      };
    }

    throw new SearchHubError("blocked", "Too many redirects");
  };
}

function extractErrorMessage(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 300);
  if (typeof data !== "object" || data === null) return "";
  const record = data as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "error_description"]) {
    const value = record[key];
    if (typeof value === "string") return value.slice(0, 300);
    if (value && typeof value === "object") {
      const nested = extractErrorMessage(value);
      if (nested) return nested;
    }
  }
  return "";
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 3_600_000));
  return undefined;
}
