import { isIP } from "node:net";
import { usageError } from "../errors/index.js";

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const ip = isIP(host);
  if (ip === 4) return host.split(".").map(Number).every((part) => part >= 0 && part <= 255) && host.startsWith("127.");
  return false;
}

/** Validates the CLI's trust boundary before any network request is made. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usageError(`Invalid Search Hub URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usageError("Search Hub URL must use https:// (or http:// for a loopback host)");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw usageError("Search Hub URL must not contain userinfo or credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw usageError("Search Hub URL must not contain a query string or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw usageError("Remote Search Hub URLs must use HTTPS; plain HTTP is allowed only for loopback hosts");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

export function joinServerUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
