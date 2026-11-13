const TRACKING_PARAMS = new Set([
  "gclid",
  "dclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_ga",
  "_gl",
  "ref_src",
  "ref_url",
  "spm",
  "scm",
  "from_source",
  "share_token",
  "wt_mc",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_"];

/** Returns true when a query parameter is pure tracking noise. */
export function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripHash(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf("#");
  return hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
}

/**
 * Canonical URL used for exact de-duplication.
 * Keeps semantic query parameters (sorted) and drops tracking parameters.
 * Returns null for non-http(s) or malformed URLs.
 */
export function normalizeUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (isTrackingParam(key)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";
  url.pathname = path;

  return url.toString();
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Normalized title used for near-duplicate detection. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[|·—–:：\-_/\\()[\]{}"'“”‘’.,!?;，。！？；、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeTitle(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  if (!normalized) return new Set();
  const latin = normalized.split(" ").filter(Boolean);
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  const bigrams = new Set<string>();
  for (let i = 0; i < cjk.length - 1; i += 1) {
    bigrams.add(`${cjk[i]}${cjk[i + 1]}`);
  }
  return new Set([...latin, ...cjk, ...bigrams]);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Rough content fingerprint; deterministic and dependency-free. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
