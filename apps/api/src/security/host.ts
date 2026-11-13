import { hostnameOf } from "../config.js";

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIpLiteral(hostname: string): boolean {
  if (IPV4.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  // IPv6 literals arrive without brackets after hostnameOf().
  return hostname.includes(":");
}

/**
 * DNS-rebinding guard.
 *
 * A browser can be tricked into sending requests to a local service with the
 * attacker's hostname in the Host header. We therefore accept:
 *   - IP literals (127.0.0.1, 192.168.x.x, ::1, ...)
 *   - `localhost`
 *   - explicit hostnames from SEARCH_HUB_ALLOWED_HOSTS / SEARCH_HUB_PUBLIC_URL
 *
 * Anything else is rejected before authentication, so a rebound domain cannot
 * even probe whether a token is valid.
 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (hostname === "localhost") return true;
  if (isIpLiteral(hostname)) return true;
  return allowedHosts.includes(hostname) || allowedHosts.includes(hostHeader.toLowerCase());
}

/**
 * Origin allowlist for browser-originated calls.
 *
 * Non-browser MCP clients do not send Origin, so a missing header is fine.
 * When present it must be same-origin with the request or explicitly allowed.
 */
export function isAllowedOrigin(
  origin: string | null | undefined,
  requestOrigin: string,
  extraOrigins: string[],
  allowedHosts: string[],
): boolean {
  if (!origin) return true;
  if (origin === requestOrigin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
