/**
 * Outbound proxy support for SafeFetch.
 *
 * Trust boundary (read this before changing anything):
 *
 * - When traffic leaves through an HTTP forward proxy or an HTTP CONNECT
 *   tunnel, the *proxy* resolves and dials the destination. The connect-time
 *   `lookup` guard in `createGuardedDispatcher` never runs for the real
 *   target, so Search Hub cannot prove which address the proxy actually
 *   reached. The application can only validate the URL it asked for.
 * - Therefore a proxy is never treated as a way to "make networking work".
 *   `validateOutboundUrl` still runs before every request and every redirect
 *   hop. With the default `proxyTrust: "untrusted"` (also the effective value
 *   when the trust level is not declared at all) the private host allowlist is
 *   ignored for proxied hops, because an unchecked proxy could otherwise be
 *   used to reach loopback / RFC1918 / cloud metadata endpoints.
 * - `proxyTrust: "trusted-networks"` is an explicit operator declaration that
 *   the proxy itself enforces egress control (allow-listing, no CONNECT to
 *   internal ranges, auditing). Only then is the app-level allowlist honoured
 *   for private destinations.
 * - The proxy resolves the destination, so the connect-time `lookup` guard
 *   cannot pin an IP for proxied traffic: a proxy-side DNS rebinding is NOT
 *   detectable here. That gap is stated as `residualRisk` by
 *   `describeOutboundPolicy()` and is the reason `trusted-networks` is a
 *   declaration about infrastructure rather than a feature toggle.
 * - Proxy configuration is deployment configuration, not tenant data: it is
 *   read from `SEARCH_HUB_PROXY` / `SEARCH_HUB_NO_PROXY` /
 *   `SEARCH_HUB_PROXY_TRUST` environment variables (see
 *   `apps/api/src/config.ts`), never from the settings table, so it cannot be
 *   changed from the admin UI or leak through a settings/backup export.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ProxyAgent, type Dispatcher } from "undici";
import { SearchHubError } from "./errors.js";
import type { SsrfPolicy } from "./safe-fetch.js";

/** How much of the egress path the operator guarantees. */
export type ProxyTrust = "untrusted" | "trusted-networks";

export const PROXY_TRUST_VALUES = ["untrusted", "trusted-networks"] as const;

/**
 * Accepted spellings for the trust level.
 *
 * `untrusted` / `trusted-networks` are canonical. The aliases exist because the
 * same two states were also specified as `application-only` / `egress-enforced`
 * (they describe the same thing: who enforces the network-layer restriction).
 * Accepting both keeps a correct operator intent from failing at boot.
 */
const PROXY_TRUST_ALIASES: Record<string, ProxyTrust> = {
  untrusted: "untrusted",
  "application-only": "untrusted",
  "trusted-networks": "trusted-networks",
  "egress-enforced": "trusted-networks",
};


export type OutboundProxySource = "none" | "search-hub-env" | "conventional-env" | "explicit";

/** Raw configuration as read from the environment (or from a test). */
export interface OutboundProxyInput {
  /** Absolute `http://` or `https://` proxy URL. May embed credentials. */
  proxy?: string | null;
  /** Comma/whitespace separated bypass list (`NO_PROXY` semantics). */
  noProxy?: string | null;
  /** Defaults to `"untrusted"` when the proxy is configured. */
  proxyTrust?: ProxyTrust | string | null;
  source?: OutboundProxySource;
}

/** A validated proxy endpoint. `display` is always credential-free. */
export interface ResolvedProxy {
  /** `scheme://host:port`, never contains userinfo. Safe for logs and APIs. */
  readonly display: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly port: number;
  readonly hasCredentials: boolean;
  /**
   * Pre-computed `Proxy-Authorization` header value.
   *
   * Defined as a **non-enumerable** property on the object, so
   * `JSON.stringify()`, `console.log()` and pino's object serialisation skip
   * it. Read it directly (`proxy.authorization`) when building a dispatcher;
   * never spread or serialise a `ResolvedProxy` and expect it to survive.
   */
  readonly authorization: string | null;
}

export interface ResolvedOutboundProxy {
  readonly enabled: boolean;
  readonly proxy: ResolvedProxy | null;
  readonly noProxy: readonly string[];
  readonly trust: ProxyTrust;
  /** False when `proxyTrust` was left unset and the secure default applied. */
  readonly trustDeclared: boolean;
  readonly source: OutboundProxySource;
}

const SUPPORTED_PROXY_SCHEMES = new Set(["http:", "https:"]);
const MAX_NO_PROXY_ENTRIES = 200;
const MAX_PROXY_URL_LENGTH = 2_048;

function defaultPortFor(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

/**
 * Strips userinfo from a proxy URL. Unparseable input returns a placeholder
 * instead of the original string, because we cannot know whether it holds a
 * password.
 */
export function redactProxyUrl(raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "[invalid-proxy-url]";
  }
  const host = isIP(url.hostname) === 6 ? `[${url.hostname}]` : url.hostname;
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
  return `${url.protocol}//${host}${port}${path}`;
}

/**
 * Last-resort scrubber for third-party error strings. undici may echo the
 * proxy URI in a connect error; that URI must never carry credentials.
 */
export function stripUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, "$1[redacted]@");
}

function normalizeNoProxy(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const entries = raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(entries)].slice(0, MAX_NO_PROXY_ENTRIES);
  return unique.map((item) => item.slice(0, 253));
}

function parseProxyUrl(raw: string): ResolvedProxy {
  if (raw.length > MAX_PROXY_URL_LENGTH) {
    throw new SearchHubError(
      "validation_error",
      `Outbound proxy URL is longer than ${MAX_PROXY_URL_LENGTH} characters`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SearchHubError(
      "validation_error",
      `Invalid outbound proxy URL "${redactProxyUrl(raw)}": expected an absolute URL such as http://proxy.internal:3128`,
    );
  }

  if (!SUPPORTED_PROXY_SCHEMES.has(url.protocol)) {
    throw new SearchHubError(
      "validation_error",
      `Unsupported outbound proxy scheme "${url.protocol}" in "${redactProxyUrl(raw)}". ` +
        "Only http:// and https:// forward proxies are supported; " +
        "socks://, socks5://, pac+http://, file:// and data: proxies are rejected because " +
        "the application cannot apply its destination checks to them.",
    );
  }
  if (!url.hostname) {
    throw new SearchHubError(
      "validation_error",
      `Outbound proxy URL "${redactProxyUrl(raw)}" has no hostname`,
    );
  }

  const port = url.port ? Number(url.port) : defaultPortFor(url.protocol);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SearchHubError(
      "validation_error",
      `Outbound proxy URL "${redactProxyUrl(raw)}" has an invalid port`,
    );
  }

  const hasCredentials = Boolean(url.username || url.password);
  let authorization: string | null = null;
  if (hasCredentials) {
    // Percent-decoding can throw on a malformed URL; fall back to the raw text
    // so a broken credential string cannot crash the process at boot.
    const user = safeDecode(url.username);
    const pass = safeDecode(url.password);
    authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }

  const host = isIP(url.hostname) === 6 ? `[${url.hostname}]` : url.hostname;
  const resolved: ResolvedProxy = {
    display: `${url.protocol}//${host}:${port}`,
    protocol: url.protocol as "http:" | "https:",
    hostname: url.hostname,
    port,
    hasCredentials,
    authorization: null,
  };
  // `authorization` is deliberately non-enumerable: any accidental
  // JSON.stringify / console.log / logger.info of this object then omits the
  // credential instead of printing a usable Basic token.
  Object.defineProperty(resolved, "authorization", {
    value: authorization,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return resolved;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Validates raw proxy configuration. Throws `validation_error` (fail closed)
 * for unsupported schemes, malformed URLs or an unknown trust level instead of
 * silently falling back to a direct connection.
 */
export function resolveOutboundProxy(input: OutboundProxyInput = {}): ResolvedOutboundProxy {
  const trustRaw = typeof input.proxyTrust === "string" ? input.proxyTrust.trim().toLowerCase() : "";
  let trust: ProxyTrust = "untrusted";
  let trustDeclared = false;
  if (trustRaw) {
    const mapped = PROXY_TRUST_ALIASES[trustRaw];
    if (!mapped) {
      throw new SearchHubError(
        "validation_error",
        `Invalid outbound proxy trust level "${input.proxyTrust}". Supported values: ${PROXY_TRUST_VALUES.join(", ")}` +
          " (aliases: application-only = untrusted, egress-enforced = trusted-networks)",
      );
    }
    trust = mapped;
    trustDeclared = true;
  }

  const noProxy = normalizeNoProxy(input.noProxy);
  const proxyRaw = (input.proxy ?? "").trim();
  const source = input.source ?? "explicit";

  if (!proxyRaw) {
    return { enabled: false, proxy: null, noProxy, trust, trustDeclared, source };
  }

  return {
    enabled: true,
    proxy: parseProxyUrl(proxyRaw),
    noProxy,
    trust,
    trustDeclared,
    source,
  };
}

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

/** IPv4 CIDR is exact; IPv6 CIDR is matched on the normalised textual prefix. */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;

  const version = isIP(ip);
  if (version === 0 || version !== isIP(base)) return false;

  if (version === 4) {
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(base);
    if (ipInt === null || baseInt === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }
  return ip.toLowerCase().startsWith(base.toLowerCase());
}

interface NoProxyEntry {
  host: string;
  port: number | null;
  cidr: boolean;
}

function splitNoProxyEntry(entry: string): NoProxyEntry {
  if (entry.includes("/") && !entry.includes("://")) {
    return { host: entry, port: null, cidr: true };
  }
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end > 0) {
      const rest = entry.slice(end + 1);
      const parsedPort = rest.startsWith(":") ? Number(rest.slice(1)) : Number.NaN;
      return {
        host: entry.slice(1, end),
        port: Number.isInteger(parsedPort) ? parsedPort : null,
        cidr: false,
      };
    }
  }
  const colon = entry.lastIndexOf(":");
  // A single colon with a numeric suffix is a port; two or more colons is IPv6.
  if (colon > -1 && entry.indexOf(":") === colon) {
    const parsedPort = Number(entry.slice(colon + 1));
    return {
      host: entry.slice(0, colon),
      port: Number.isInteger(parsedPort) ? parsedPort : null,
      cidr: false,
    };
  }
  return { host: entry, port: null, cidr: false };
}

/**
 * `NO_PROXY` semantics:
 * - `*` bypasses the proxy for every destination.
 * - `example.com` matches `example.com` and every subdomain (label boundary).
 * - `.example.com` / `*.example.com` match subdomains and the apex.
 * - `host:port` / `[::1]:8080` only match that port.
 * - `10.0.0.0/8` matches IP literals inside the CIDR (no DNS lookup).
 */
export function noProxyMatches(
  hostname: string,
  port: number,
  entries: readonly string[],
): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;

  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;

    const parsed = splitNoProxyEntry(entry);
    if (!parsed.host) continue;
    if (parsed.port !== null && parsed.port !== port) continue;
    if (parsed.cidr) {
      if (ipMatchesCidr(host, parsed.host)) return true;
      continue;
    }

    const bare = parsed.host.replace(/^\*\./, ".").replace(/^\*/, "").replace(/\.$/, "");
    if (!bare) continue;
    const apex = bare.startsWith(".") ? bare.slice(1) : bare;
    const suffix = `.${apex}`;
    // A partial label (`ample.com` vs `example.com`) must never match.
    if (host === apex || host.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Returns the proxy that should serve this URL, or `null` for a direct
 * connection (proxy disabled, or `NO_PROXY` bypass).
 */
export function proxyForUrl(
  config: ResolvedOutboundProxy,
  target: string | URL,
): ResolvedProxy | null {
  if (!config.enabled || !config.proxy) return null;
  let url: URL;
  if (typeof target === "string") {
    try {
      url = new URL(target);
    } catch {
      return config.proxy;
    }
  } else {
    url = target;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : defaultPortFor(url.protocol);
  if (noProxyMatches(host, port, config.noProxy)) return null;
  return config.proxy;
}

/**
 * Builds an undici `ProxyAgent` for a validated proxy.
 *
 * - `proxyTunnel: true` forces every proxied request — including plain HTTP —
 *   through an HTTP `CONNECT host:port` tunnel. That keeps the trust boundary
 *   explicit and auditable: the proxy always sees an exact host:port pair and
 *   the application never sends an absolute-form request-target that a proxy
 *   could interpret differently from the `Host` header.
 * - Certificate validation towards the target and towards an https proxy is
 *   intentionally left on.
 * - Credentials are passed via `token` (a pre-computed `Proxy-Authorization`
 *   value) rather than embedded in the URI, so they never end up in the
 *   agent's stored `uri` or in an error string.
 */
export function createProxyDispatcher(
  proxy: ResolvedProxy,
  options: { connectTimeoutMs?: number } = {},
): Dispatcher {
  const host = isIP(proxy.hostname) === 6 ? `[${proxy.hostname}]` : proxy.hostname;
  return new ProxyAgent({
    uri: `${proxy.protocol}//${host}:${proxy.port}`,
    ...(proxy.authorization ? { token: proxy.authorization } : {}),
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    proxyTunnel: true,
  });
}

/**
 * Process-wide cache of proxy dispatchers.
 *
 * SafeFetch instances are rebuilt whenever settings change; without a cache
 * each rebuild would leak an undici pool (and its sockets). The key uses a
 * short SHA-256 of the `Proxy-Authorization` value rather than the value
 * itself, so rotated credentials get a fresh agent without the secret sitting
 * in a long-lived Map.
 */
const proxyDispatcherCache = new Map<string, Dispatcher>();
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;

function proxyCacheKey(proxy: ResolvedProxy, connectTimeoutMs: number): string {
  const credentials = proxy.authorization
    ? createHash("sha256").update(proxy.authorization).digest("hex").slice(0, 16)
    : "none";
  return `${proxy.display}|${credentials}|${connectTimeoutMs}`;
}

export function getProxyDispatcher(
  proxy: ResolvedProxy,
  options: { connectTimeoutMs?: number } = {},
): Dispatcher {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_PROXY_CONNECT_TIMEOUT_MS;
  const key = proxyCacheKey(proxy, connectTimeoutMs);
  const existing = proxyDispatcherCache.get(key);
  if (existing) return existing;
  const created = createProxyDispatcher(proxy, { connectTimeoutMs });
  proxyDispatcherCache.set(key, created);
  return created;
}

/**
 * Test helper: drops cached dispatchers so sockets do not outlive a suite.
 */
export function resetProxyDispatchers(): void {
  for (const dispatcher of proxyDispatcherCache.values()) void dispatcher.close();
  proxyDispatcherCache.clear();
}

export interface OutboundPolicyDescription {
  mode: "direct" | "proxy";
  proxyTrust: ProxyTrust;
  proxyTrustDeclared: boolean;
  /** Redacted proxy endpoint (`http://host:port`), never credentials. */
  proxyHost: string | null;
  proxyHasCredentials: boolean;
  noProxyEntries: number;
  noProxy: string[];
  privateHostAllowlistEntries: number;
  /**
   * False while the proxy is untrusted: the allowlist is then ignored for
   * proxied hops (it still applies to NO_PROXY direct hops).
   */
  privateHostAllowlistHonored: boolean;
  allowHttp: boolean;
  maxRedirects: number;
  /**
   * One-line statement of what remains unverifiable in the current mode, for
   * health checks and the admin UI. Null in direct mode.
   */
  residualRisk: string | null;
  /** Checks the application performs before every request and redirect hop. */
  appEnforced: string[];
  /** Controls only the proxy / operator can provide. */
  proxyMustEnforce: string[];
  warnings: string[];
}

/**
 * Credential-free, side-effect-free view of the current outbound policy, for
 * `/api/health`, the admin settings screen and boot logs.
 */
export function describeOutboundPolicy(
  policy: SsrfPolicy,
  config: ResolvedOutboundProxy,
): OutboundPolicyDescription {
  const proxyHost = config.proxy?.display ?? null;
  const allowlistHonored = !config.enabled || config.trust === "trusted-networks";
  const warnings: string[] = [];

  if (config.enabled) {
    warnings.push(
      "Proxied requests are resolved by the proxy; the application validates the requested " +
        "URL but cannot verify which address the proxy dials.",
    );
    if (!config.trustDeclared) {
      warnings.push(
        "The outbound proxy is configured without an explicit trust level, so it is treated as " +
          "untrusted: loopback, private, CGNAT, link-local and metadata destinations are rejected " +
          "regardless of the private host allowlist.",
      );
    } else if (config.trust === "trusted-networks") {
      warnings.push(
        "proxyTrust=trusted-networks: SSRF protection for proxied requests now depends on the " +
          "proxy enforcing egress control. Verify that it blocks internal ranges.",
      );
    }
    if (!allowlistHonored && policy.allowPrivateHosts.length > 0) {
      warnings.push(
        `${policy.allowPrivateHosts.length} private host allowlist entr${
          policy.allowPrivateHosts.length === 1 ? "y is" : "ies are"
        } ignored while the proxy is untrusted.`,
      );
    }
  }

  // Stated once, in the same words, everywhere it is surfaced (boot log,
  // /api/health, /api/admin/outbound) so the wording cannot drift.
  let residualRisk: string | null = null;
  if (config.enabled && !config.trustDeclared) {
    residualRisk =
      "Proxy trust level is not declared: only application-layer checks protect proxied requests, " +
      "and the proxy resolves the destination (DNS rebinding at the proxy is not detectable here). " +
      "Set SEARCH_HUB_PROXY_TRUST after confirming the proxy blocks internal egress.";
  } else if (config.enabled && config.trust === "untrusted") {
    residualRisk =
      "The proxy is treated as untrusted: application-layer checks only. The proxy resolves the " +
      "destination, so DNS rebinding at the proxy cannot be detected by this service.";
  } else if (config.enabled) {
    residualRisk =
      "Network-layer restriction is delegated to the proxy (egress-enforced). Application-layer " +
      "URL/DNS checks still run as defence in depth but cannot verify the proxy's behaviour.";
  }

  return {
    mode: config.enabled ? "proxy" : "direct",
    proxyTrust: config.trust,
    proxyTrustDeclared: config.trustDeclared,
    proxyHost,
    proxyHasCredentials: config.proxy?.hasCredentials ?? false,
    noProxyEntries: config.noProxy.length,
    noProxy: [...config.noProxy],
    privateHostAllowlistEntries: policy.allowPrivateHosts.length,
    privateHostAllowlistHonored: allowlistHonored,
    allowHttp: policy.allowHttp,
    maxRedirects: policy.maxRedirects,
    residualRisk,
    appEnforced: [
      `URL scheme restricted to http(s); plain HTTP ${policy.allowHttp ? "allowed by policy" : "disabled"}`,
      "URLs with embedded credentials rejected",
      "DNS resolution and CIDR classification (loopback, RFC1918, CGNAT, link-local, multicast, reserved, IPv6 ULA/link-local)",
      "Cloud metadata addresses (169.254.169.254, 100.100.100.200, fd00:ec2::254) always rejected",
      "Internal hostnames (localhost, *.localhost, *.local, metadata.google.internal) rejected",
      `Redirects followed manually (max ${policy.maxRedirects}) and re-validated at every hop`,
      "Direct connections additionally filter addresses in the connect-time lookup guard (DNS rebinding)",
    ],
    proxyMustEnforce: [
      "Resolve the CONNECT / absolute-form target and block loopback, RFC1918, link-local, CGNAT and metadata egress",
      "Authenticate clients and keep proxy credentials out of proxy access logs",
      "Log and rate-limit egress so an abused destination is detectable",
    ],
    warnings,
  };
}
