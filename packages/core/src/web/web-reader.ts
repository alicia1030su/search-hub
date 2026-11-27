import * as cheerio from "cheerio";
import { sanitizeUrl, SearchHubError, type SafeFetch, type SafeFetchInit } from "@search-hub/shared";

export type WebpageReadStatus =
  | "ok"
  | "login_required"
  | "captcha"
  | "maintenance"
  | "not_found"
  | "unsupported";

export type WebpageReasonCode =
  | "ok"
  | "captcha_detected"
  | "login_required"
  | "maintenance"
  | "not_found"
  | "unsupported_content";

export interface WebpageReadOptions {
  fetch: SafeFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxContentChars?: number;
  maxHtmlBytes?: number;
}

export interface WebpageReadResult {
  title: string | null;
  content: string | null;
  author: string | null;
  publishedAt: string | null;
  requestedUrl: string;
  finalUrl: string;
  contentLength: number;
  readStatus: WebpageReadStatus;
  truncated: boolean;
  reasonCode: WebpageReasonCode;
}

type HtmlNode = ReturnType<cheerio.Cheerio<never>["contents"]> extends cheerio.Cheerio<infer T> ? T : never;

export const DEFAULT_WEB_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_MAX_CONTENT_CHARS = 50_000;
export const DEFAULT_WEB_MAX_HTML_BYTES = 2 * 1024 * 1024;

const REASON_BY_STATUS: Record<WebpageReadStatus, WebpageReasonCode> = {
  ok: "ok",
  captcha: "captcha_detected",
  login_required: "login_required",
  maintenance: "maintenance",
  not_found: "not_found",
  unsupported: "unsupported_content",
};

const REMOVED_SELECTOR = "script, style, noscript, template, svg, canvas, iframe, nav, footer, aside, form";
const CAPTCHA_SELECTOR = [
  "#cf-chl",
  "[class*='cf-chl']",
  "[class*='g-recaptcha']",
  "[class*='h-captcha']",
  "script[src*='g-recaptcha']",
  "script[src*='hcaptcha']",
  "iframe[src*='g-recaptcha']",
  "iframe[src*='hcaptcha']",
].join(", ");
const NOT_FOUND_TITLE = /^(?:404(?:\s+|-)(?:page\s+)?not\s*found|page\s+not\s*found|not\s*found)$/i;
const NOT_FOUND_BODY = /\b(?:page|resource|url|content)(?:\s+\w+){0,4}\s+(?:could\s+not|couldn't|can't|cannot)\s+be\s+found\b|\b(?:404|page)\s+(?:error|not\s+found)\b/i;
const LOGIN_TITLE = /^(?:log\s*in|sign\s*in|login|signin)(?:\s+(?:to|\||-|–)\s+.{1,80})?$/i;
const MAINTENANCE_TITLE = /^(?:(?:site|website|service|server)\s+)?(?:under\s+)?maintenance(?:\s+(?:mode|in\s+progress|break))?$/i;
const MAINTENANCE_BODY = /\b(?:under|temporarily\s+down\s+for|scheduled)\s+maintenance\b|\b(?:be\s+back|back\s+soon|try\s+again)\s+(?:online|shortly|later)\b|\bmaintenance\s+(?:mode|window|in\s+progress)\b/i;
const LOGIN_PATH = /(?:^|[/._-])(?:login|log-in|signin|sign-in|auth|session)(?:[/._-]|$)/i;
const HTML_CONTENT_TYPE = /(?:text\/html|application\/xhtml\+xml)/i;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function wordCount(value: string): number {
  return (value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u3400-\u9fff]/g) ?? []).length;
}

function cleanMetadata(value: string | undefined): string | null {
  const normalized = normalize(value ?? "");
  return normalized || null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Webpage content and byte limits must be positive safe integers");
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function parseRequestedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError("Invalid webpage URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Webpage URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new TypeError("Webpage URL must not contain credentials");
  return url;
}

function metadata($: cheerio.CheerioAPI, selectors: string[]): string | null {
  for (const selector of selectors) {
    const value = cleanMetadata($(selector).first().attr("content"));
    if (value) return value;
  }
  return null;
}

function inlineMarkdown($: cheerio.CheerioAPI, element: cheerio.Cheerio<HtmlNode>): string {
  let text = "";
  element.contents().each((_index, node) => {
    if (node.type === "text") {
      text += node.data;
      return;
    }
    if (node.type !== "tag") return;
    const child = $(node);
    const tag = child.prop("tagName")?.toLowerCase();
    const inner = inlineMarkdown($, child);
    if (tag === "strong" || tag === "b") text += `**${inner.trim()}**`;
    else if (tag === "em" || tag === "i") text += `*${inner.trim()}*`;
    else if (tag === "code") text += `\`${inner.trim()}\``;
    else if (tag === "br") text += "\n";
    else if (tag === "a") {
      const href = child.attr("href")?.trim();
      text += href ? `[${inner.trim()}](${href})` : inner;
    } else text += inner;
  });
  return text;
}

function toMarkdown($: cheerio.CheerioAPI, root: cheerio.Cheerio<HtmlNode>): string {
  const blocks: string[] = [];
  const walk = (parent: cheerio.Cheerio<HtmlNode>): void => {
    parent.contents().each((_index, node) => {
      if (node.type === "text") {
        const text = normalize(node.data);
        if (text) blocks.push(text);
        return;
      }
      if (node.type !== "tag") return;
      const element = $(node);
      const tag = element.prop("tagName")?.toLowerCase() ?? "";
      if (/^h[1-6]$/.test(tag)) {
        const text = normalize(inlineMarkdown($, element));
        if (text) blocks.push(`${"#".repeat(Number(tag[1]))} ${text}`);
      } else if (tag === "li") {
        const text = normalize(inlineMarkdown($, element));
        if (text) blocks.push(`- ${text}`);
      } else if (tag === "blockquote") {
        const text = normalize(inlineMarkdown($, element));
        if (text) blocks.push(text.split("\n").map((line) => `> ${line}`).join("\n"));
      } else if (tag === "pre") {
        const text = element.text().replace(/\n+$/, "");
        if (text.trim()) blocks.push(`\`\`\`\n${text}\n\`\`\``);
      } else if (tag === "img") {
        const alt = normalize(element.attr("alt") ?? "");
        const src = element.attr("src")?.trim();
        if (src) blocks.push(`![${alt}](${src})`);
      } else if (tag === "hr") {
        blocks.push("---");
      } else if (["p", "div", "section", "article", "main", "body", "ul", "ol"].includes(tag)) {
        const directBlocks = element.children("p, div, section, article, main, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6").length;
        if (directBlocks === 0) {
          const text = normalize(inlineMarkdown($, element));
          if (text) blocks.push(text);
        } else walk(element);
      } else {
        const text = normalize(inlineMarkdown($, element));
        if (text) blocks.push(text);
      }
    });
  };
  walk(root);
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function unavailableResult(
  requestedUrl: string,
  finalUrl: string,
  readStatus: WebpageReadStatus,
  metadataValues: { title?: string | null; author?: string | null; publishedAt?: string | null } = {},
): WebpageReadResult {
  return {
    title: metadataValues.title ?? null,
    content: null,
    author: metadataValues.author ?? null,
    publishedAt: metadataValues.publishedAt ?? null,
    requestedUrl,
    finalUrl,
    contentLength: 0,
    readStatus,
    truncated: false,
    reasonCode: REASON_BY_STATUS[readStatus],
  };
}

function upstreamStatus(error: unknown): number | null {
  if (!(error instanceof SearchHubError) || !error.details || typeof error.details !== "object") return null;
  const status = (error.details as { upstreamStatus?: unknown }).upstreamStatus;
  return typeof status === "number" ? status : null;
}

function upstreamUrl(error: unknown, fallback: string): string {
  if (!(error instanceof SearchHubError) || !error.details || typeof error.details !== "object") return fallback;
  const url = (error.details as { url?: unknown }).url;
  return typeof url === "string" ? sanitizeUrl(url) : fallback;
}

/** Read a public HTTP page into bounded Markdown without launching a browser. */
export async function fetchWebpage(rawUrl: string, options: WebpageReadOptions): Promise<WebpageReadResult> {
  const requested = parseRequestedUrl(rawUrl);
  const requestedUrl = sanitizeUrl(rawUrl);
  throwIfAborted(options.signal);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WEB_READ_TIMEOUT_MS);
  const maxContentChars = positiveInteger(options.maxContentChars, DEFAULT_WEB_MAX_CONTENT_CHARS);
  const maxHtmlBytes = positiveInteger(options.maxHtmlBytes, DEFAULT_WEB_MAX_HTML_BYTES);

  let response;
  try {
    response = await options.fetch<string>(requested.toString(), {
      signal: options.signal,
      timeoutMs,
      maxBytes: maxHtmlBytes,
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
    } satisfies SafeFetchInit);
  } catch (error) {
    throwIfAborted(options.signal);
    const status = upstreamStatus(error);
    if (status === 503) return unavailableResult(requestedUrl, upstreamUrl(error, requestedUrl), "maintenance");
    if (status === 404 || status === 410) return unavailableResult(requestedUrl, upstreamUrl(error, requestedUrl), "not_found");
    throw error;
  }
  throwIfAborted(options.signal);

  const finalUrl = sanitizeUrl(response.url || requested.toString());
  const httpUnavailableStatus: WebpageReadStatus | null = response.status === 503
    ? "maintenance"
    : response.status === 404 || response.status === 410 ? "not_found" : null;

  const contentType = response.headers.get("content-type") ?? "";
  if (typeof response.data !== "string" || !HTML_CONTENT_TYPE.test(contentType)) {
    return unavailableResult(requestedUrl, finalUrl, httpUnavailableStatus ?? "unsupported");
  }
  const htmlBytes = Buffer.byteLength(response.data, "utf8");
  if (htmlBytes > maxHtmlBytes) return unavailableResult(requestedUrl, finalUrl, "unsupported");
  if (response.data.length === 0) {
    return unavailableResult(requestedUrl, finalUrl, httpUnavailableStatus ?? "unsupported");
  }

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(response.data);
  } catch {
    return unavailableResult(requestedUrl, finalUrl, "unsupported");
  }
  const title = cleanMetadata($("title").first().text()) ?? cleanMetadata($("h1").first().text());
  const author = metadata($, ["meta[name='author']", "meta[property='article:author']", "meta[name='byl']"]);
  const publishedAt = metadata($, [
    "meta[property='article:published_time']",
    "meta[name='date']",
    "meta[name='pubdate']",
    "time[datetime]",
  ]);

  // Evaluate challenge/login markers before removing forms and iframes from the article.
  const captchaElement = $(CAPTCHA_SELECTOR).length > 0;
  const humanTitle = /^(?:verify you are human|please verify you are human)(?:\s*[|-].{0,80})?$/i.test(title ?? "");
  if (captchaElement || (humanTitle && $("form").length > 0)) {
    return unavailableResult(requestedUrl, finalUrl, "captcha", { title, author, publishedAt });
  }

  $("head script, head style, head noscript, head template").remove();
  const textForClassification = normalize($("body").text());
  const words = wordCount(textForClassification);
  const passwordInput = $("input[type='password']").length > 0;
  const loginForm = passwordInput && $("form").toArray().some((form) => {
    const action = $(form).attr("action") ?? "";
    return LOGIN_PATH.test(action) || $(form).text().toLowerCase().includes("login") || $(form).text().toLowerCase().includes("sign in");
  });
  if (words < 200 && (loginForm || (LOGIN_TITLE.test(title ?? "") && (passwordInput || words < 200)))) {
    return unavailableResult(requestedUrl, finalUrl, "login_required", { title, author, publishedAt });
  }

  if (response.status === 404 || response.status === 410) {
    return unavailableResult(requestedUrl, finalUrl, "not_found", { title, author, publishedAt });
  }
  const exactNotFound = (title ?? "").split(/\s+[|-]\s+/).some((part) => NOT_FOUND_TITLE.test(normalize(part)))
    || NOT_FOUND_TITLE.test(normalize($("h1").first().text()));
  if (exactNotFound && NOT_FOUND_BODY.test(textForClassification)) {
    return unavailableResult(requestedUrl, finalUrl, "not_found", { title, author, publishedAt });
  }

  const maintenanceTitle = (title ?? "").split(/\s+[|-]\s+/).some((part) => MAINTENANCE_TITLE.test(normalize(part)));
  if (response.status === 503) {
    return unavailableResult(requestedUrl, finalUrl, "maintenance", { title, author, publishedAt });
  }
  if (response.headers.has("retry-after") && maintenanceTitle && words < 200) {
    return unavailableResult(requestedUrl, finalUrl, "maintenance", { title, author, publishedAt });
  }
  if (maintenanceTitle && words < 200 && MAINTENANCE_BODY.test(textForClassification)) {
    return unavailableResult(requestedUrl, finalUrl, "maintenance", { title, author, publishedAt });
  }

  $(REMOVED_SELECTOR).remove();
  $("[hidden], [aria-hidden='true']").remove();
  const article = $("article").first();
  const main = $("main").first();
  const root = article.length ? article : main.length ? main : $("body");
  const markdown = toMarkdown($, root);
  const truncated = markdown.length > maxContentChars;
  const content = markdown.slice(0, maxContentChars);
  if (wordCount(markdown) < 20 || markdown.replace(/[#>*_`![]()\s-]/g, "").length < 40) {
    return unavailableResult(requestedUrl, finalUrl, "unsupported", { title, author, publishedAt });
  }

  return {
    title,
    content,
    author,
    publishedAt,
    requestedUrl,
    finalUrl,
    contentLength: content.length,
    readStatus: "ok",
    truncated,
    reasonCode: "ok",
  };
}
