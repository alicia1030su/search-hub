import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { SearchHubError } from "./errors.js";
import {
  getProxyDispatcher,
  proxyForUrl,
  resolveOutboundProxy,
  stripUrlCredentials,
  type OutboundProxyInput,
  type ResolvedOutboundProxy,
  type ResolvedProxy,
} from "./outbound-proxy.js";
import type { SafeFetch, SafeFetchInit, SafeFetchResponse } from "./types.js";
import {
  redactExactSecrets,
  redactSensitiveQueryParams,
  sanitizeUrl,
  sensitiveQueryValues,
} from "./url-redaction.js";

export interface SsrfPolicy {
  /** Exact hostnames or suffix patterns beginning with a dot (".internal"). */
  allowPrivateHosts: string[];
  maxRedirects: number;
  /** Default true so self-hosted SearXNG over http keeps working. */
  allowHttp: boolean;
}

/** Replaceable DNS resolver, so tests can simulate rebinding deterministically. */
export type HostResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfDeps {
  /** Defaults to the system resolver (`dns.lookup` with `{all:true}`). */
  resolveHost?: HostResolver;
}

const systemResolver: HostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

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

/**
 * Normalizes IPv4-mapped IPv6 to plain IPv4 so one blocklist covers both.
 *
 * The WHATWG URL parser rewrites `::ffff:127.0.0.1` to the compressed hex form
 * `::ffff:7f00:1`, so both spellings must be handled — otherwise a URL literal
 * would slip past the CIDR list while the same address written as IPv4 is
 * rejected.
 */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:") && lower.includes(".")) return lower.slice(7);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
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
  deps: SsrfDeps = {},
  diagnosticSecrets: string[] = [],
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SearchHubError("bad_request", `Invalid URL: ${sanitizeUrl(rawUrl, diagnosticSecrets)}`);
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
    const resolveHost = deps.resolveHost ?? systemResolver;
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await resolveHost(hostname);
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
 * Builds the connect-time `lookup` used by the direct agent.
 *
 * Node's net.connect calls lookup with `all: true` when autoSelectFamily is
 * enabled (the default on Node 20+). Returning a single address in that mode
 * crashes with ERR_INVALID_IP_ADDRESS, so the callback shape follows the
 * requested option.
 *
 * Exported separately so the guard can be unit-tested without an HTTP layer.
 */
export function createGuardedLookup(
  policy: SsrfPolicy = DEFAULT_SSRF_POLICY,
  deps: SsrfDeps = {},
): typeof import("node:dns").lookup {
  const resolveHost = deps.resolveHost ?? systemResolver;
  return ((
    hostname: string,
    options: Record<string, unknown>,
    callback: (...args: unknown[]) => void,
  ) => {
    const allowlisted = hostIsAllowlisted(hostname, policy.allowPrivateHosts);
    resolveHost(hostname)
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
}

/**
 * Connect-time DNS guard. Even if an attacker changes the DNS answer between
 * validation and connection, the socket can only reach an approved address.
 *
 * This guard is only effective for DIRECT connections. When a proxy dispatcher
 * is used the destination is resolved by the proxy, so `validateOutboundUrl`
 * (which runs before every request and every redirect hop) is the only
 * application-level check. See `outbound-proxy.ts` for the trust boundary.
 */
export function createGuardedDispatcher(
  policy: SsrfPolicy = DEFAULT_SSRF_POLICY,
  deps: SsrfDeps = {},
): Dispatcher {
  return new Agent({
    connect: {
      lookup: createGuardedLookup(policy, deps),
    },
  });
}

export interface SafeFetchOptions {
  policy?: SsrfPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  /** Optional fixed headers, for example User-Agent. */
  defaultHeaders?: Record<string, string>;
  /** Deployment-level proxy configuration. Omitted means a direct connection. */
  proxy?: OutboundProxyInput | ResolvedOutboundProxy;
  /** Injected resolver, used by tests to simulate DNS rebinding. */
  resolveHost?: HostResolver;
}

function isResolvedProxy(value: OutboundProxyInput | ResolvedOutboundProxy): value is ResolvedOutboundProxy {
  return typeof (value as ResolvedOutboundProxy).enabled === "boolean" && "trust" in value;
}

/** Turns undici proxy failures into stable, credential-free errors. */
function proxyFailure(
  proxy: ResolvedProxy,
  error: unknown,
  target: string,
): SearchHubError | null {
  // undici reports a refused tunnel as `AbortError: Proxy response (407) !==
  // 200 when HTTP Tunneling`, wrapped in "Request was cancelled" / "fetch
  // failed". Walk the whole chain instead of only the top-level message.
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth += 1) {
    messages.push(`${current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  const raw = messages.join(" | ");
  const statusMatch = /Proxy response \((\d{3})\)/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (status === 407) {
    return new SearchHubError(
      "blocked",
      `Outbound proxy ${proxy.display} requires authentication (HTTP 407). ` +
        "Verify the credentials embedded in the proxy URL configured for this deployment.",
      { status: 502, retryable: false, details: { proxy: proxy.display, proxyStatus: 407 }, cause: error },
    );
  }
  if (status !== null && status >= 400) {
    return new SearchHubError(
      "network",
      `Outbound proxy ${proxy.display} refused to reach ${target} (HTTP ${status}).`,
      {
        status: 502,
        retryable: status >= 500,
        details: { proxy: proxy.display, proxyStatus: status },
        cause: error,
      },
    );
  }
  // A proxy that is not listening at all is a deployment error, not a provider
  // error; say so instead of blaming the upstream.
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|certificate|CERT_|SSL|TLS/i.test(raw)) {
    return new SearchHubError(
      "network",
      `Could not use outbound proxy ${proxy.display} to reach ${target}. ` +
        "Check that the proxy is running and that its certificate is trusted.",
      { status: 502, retryable: true, details: { proxy: proxy.display }, cause: error },
    );
  }
  return null;
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
 * URL-validation policy for a hop that will be carried by the proxy.
 *
 * With an untrusted proxy (the default whenever a proxy is configured without
 * an explicit `proxyTrust` declaration) the private host allowlist is dropped
 * for proxied hops: the proxy resolves the destination, so an allowlisted
 * internal host would be a pivot the application cannot verify. Cloud metadata
 * addresses are rejected unconditionally by `validateOutboundUrl` in both
 * modes, and loopback / RFC1918 / CGNAT / `.local` / `localhost` targets are
 * therefore rejected before the proxy sees a single CONNECT.
 *
 * Applied per hop, not globally: a NO_PROXY bypass is a direct connection that
 * keeps the connect-time lookup guard, so it keeps the full policy.
 */
export function effectiveValidationPolicy(
  policy: SsrfPolicy,
  proxy: ResolvedOutboundProxy,
): SsrfPolicy {
  if (!proxy.enabled || proxy.trust === "trusted-networks") return policy;
  if (policy.allowPrivateHosts.length === 0) return policy;
  return { ...policy, allowPrivateHosts: [] };
}

/**
 * JSON fetch with SSRF protection, manual redirects, size caps and timeouts.
 * All outbound provider/model traffic must go through this function.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const policy = options.policy ?? DEFAULT_SSRF_POLICY;
  const defaultTimeout = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const proxyConfig: ResolvedOutboundProxy = options.proxy
    ? isResolvedProxy(options.proxy)
      ? options.proxy
      : resolveOutboundProxy(options.proxy)
    : resolveOutboundProxy({});
  // Policy for hops the proxy will carry. Direct hops (no proxy, or a NO_PROXY
  // bypass) are validated with the caller's full policy.
  const proxiedPolicy = effectiveValidationPolicy(policy, proxyConfig);
  const resolveHost = options.resolveHost;

  // The guarded agent is always built: NO_PROXY entries route those targets
  // back through the direct path, which keeps the connect-time lookup guard.
  const directDispatcher = createGuardedDispatcher(policy, { resolveHost });
  const proxyDispatcher = proxyConfig.proxy
    ? getProxyDispatcher(proxyConfig.proxy, { connectTimeoutMs: Math.min(defaultTimeout, 15_000) })
    : null;

  return async function safeFetch<T = unknown>(
    rawUrl: string,
    init: SafeFetchInit = {},
  ): Promise<SafeFetchResponse<T>> {
    let currentUrl = rawUrl;
    const timeoutMs = init.timeoutMs ?? defaultTimeout;
    const limit = init.maxBytes ?? maxBytes;
    const { onRequest, secrets: requestSecrets = [], ...requestInit } = init;

    for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
      const hopProxy = proxyForUrl(proxyConfig, currentUrl);
      // Validate with the policy that matches how this hop will actually be
      // carried. A proxied hop can never satisfy a private-host allowlist.
      await validateOutboundUrl(currentUrl, hopProxy ? proxiedPolicy : policy, { resolveHost }, requestSecrets);
      const dispatcher: Dispatcher = hopProxy && proxyDispatcher ? proxyDispatcher : directDispatcher;

      // Counted per *hop*, not per call, and only after this hop passed the
      // outbound policy: a request rejected by the SSRF guard provably never
      // left the machine, so charging it would overstate what the vendor saw.
      // Throwing here aborts before the fetch, which is what makes this a
      // budget rather than a report.
      onRequest?.(currentUrl);

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
          ...requestInit,
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
        // A caller-supplied signal is a cancellation, not a network failure.
        // Reporting it as `network` would mark the provider/key as failing and
        // retry a request the caller already abandoned.
        if (init.signal?.aborted) {
          throw new SearchHubError("cancelled", "Request cancelled by caller", {
            cause: error,
            retryable: false,
            status: 499,
          });
        }
        if (error instanceof SearchHubError) throw error;
        const mapped = hopProxy ? proxyFailure(hopProxy, error, sanitizeUrl(currentUrl, requestSecrets)) : null;
        if (mapped) throw mapped;
        throw new SearchHubError("network", `Network error requesting ${sanitizeUrl(currentUrl, requestSecrets)}`, {
          cause: error,
          retryable: true,
          status: 502,
          details: hopProxy ? { proxy: hopProxy.display } : undefined,
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

      // A forward proxy answers 407 itself; the target cannot produce it.
      // Never echo the proxy's body: some proxies reflect the request URI,
      // which may carry credentials.
      if (hopProxy && response.status === 407) {
        await response.body?.cancel();
        throw new SearchHubError(
          "blocked",
          `Outbound proxy ${hopProxy.display} requires authentication (HTTP 407). ` +
            "Verify the credentials embedded in the proxy URL configured for this deployment.",
          { status: 502, retryable: false, details: { proxy: hopProxy.display, proxyStatus: 407 } },
        );
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
        const upstreamMessage = redactSecrets(
          typeof data === "object" && data !== null
            ? extractErrorMessage(data)
            : body.slice(0, 300),
          [
            headers.get("authorization"),
            headers.get("x-api-key"),
            headers.get("x-subscription-token"),
            headers.get("proxy-authorization"),
            ...sensitiveQueryValues(currentUrl),
            ...requestSecrets,
          ],
        );
        const message = redactSensitiveQueryParams(
          hopProxy ? stripUrlCredentials(upstreamMessage) : upstreamMessage,
        );
        // A 502/503 through a forward proxy usually means the proxy could not
        // reach the destination. Say so, so operators do not debug providers.
        const proxyGateway =
          hopProxy !== null && (response.status === 502 || response.status === 503);
        const label = proxyGateway
          ? `Outbound proxy ${hopProxy.display} could not reach the destination (HTTP ${response.status})`
          : `Upstream returned HTTP ${response.status}`;
        throw new SearchHubError("bad_request", `${label}${message ? `: ${message}` : ""}`, {
          status: response.status,
          details: {
            upstreamStatus: response.status,
            url: sanitizeUrl(currentUrl, requestSecrets),
            ...(hopProxy ? { proxy: hopProxy.display } : {}),
          },
          retryable: response.status >= 500 || response.status === 429,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        });
      }

      return {
        status: response.status,
        headers: response.headers,
        data: data as T,
        url: sanitizeUrl(currentUrl, requestSecrets),
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

/**
 * Removes credential material from an upstream-controlled string.
 *
 * An upstream may echo request headers (or part of them) in an error body.
 * That body ends up in error messages, logs and the admin UI, so the exact
 * header values used for this request are replaced first, followed by
 * well-known credential shapes so an unrelated token cannot slip through.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | null | undefined> = [],
): string {
  let output = redactExactSecrets(text, secrets.filter((value): value is string => Boolean(value)));
  return redactSensitiveQueryParams(output)
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\btvly-[A-Za-z0-9_-]{8,}/g, "tvly-[redacted]")
    .replace(/\bsh_[A-Za-z0-9_-]{8,}/g, "sh_[redacted]");
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 3_600_000));
  return undefined;
}
