/**
 * scraper.ts — the core engine.
 *
 * This is deliberately framework-agnostic: it knows nothing about MCP or Apify.
 * It takes a URL, fetches the HTML, strips out navigation/ads/boilerplate using
 * Mozilla's Readability (the same library behind Firefox Reader View), and
 * converts the clean article HTML into Markdown.
 *
 * Both the MCP server (src/index.ts) and the Apify Actor (src/main.ts) call
 * scrapeUrl() so there is exactly ONE place where the scraping logic lives.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-ignore - this package ships without bundled types
import { gfm } from "turndown-plugin-gfm";
import { ScrapeError } from "./errors.js";
import { renderHtml } from "./renderer.js";

// Re-exported so existing callers can keep importing it from "./scraper.js".
export { ScrapeError } from "./errors.js";

/** Options a caller can pass to tweak scraping behaviour. */
export interface ScrapeOptions {
  /** Max time to wait for the page to respond, in milliseconds. Default 20000. */
  timeoutMs?: number;
  /** Max HTML size to accept, in bytes. Guards against huge pages. Default 5 MB. */
  maxBytes?: number;
  /**
   * If true, keep hyperlinks in the Markdown. If false, drop them and keep only
   * the link text (produces cleaner prose for LLM consumption). Default true.
   */
  includeLinks?: boolean;
  /**
   * If true, render the page in a real headless browser (Playwright) so that
   * JavaScript-built content is captured. Slower and requires Playwright to be
   * installed. Default false (fast HTTP fetch). See renderer.ts.
   */
  renderJs?: boolean;
  /**
   * When renderJs is true, extra milliseconds to wait after the page loads so
   * late client-side content can appear. Default 0.
   */
  renderWaitMs?: number;
}

/** The clean result returned to callers. */
export interface ScrapeResult {
  url: string;
  /** The article title, if Readability could detect one. */
  title: string | null;
  /** A short excerpt / description, if available. */
  excerpt: string | null;
  /** The site name (e.g. "The New York Times"), if available. */
  siteName: string | null;
  /** Approximate word count of the extracted content. */
  wordCount: number;
  /** The clean Markdown — this is the main payload. */
  markdown: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const USER_AGENT =
  "Mozilla/5.0 (compatible; clean-markdown-mcp/1.1; +https://apify.com/perforated_hummingbird/url-to-markdown)";

/** Validate and normalise the incoming URL. Only http/https are allowed. */
function normaliseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ScrapeError(
      `"${rawUrl}" is not a valid URL. Make sure it starts with http:// or https://`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScrapeError(
      `Only http and https URLs are supported (got "${parsed.protocol}").`
    );
  }
  return parsed.toString();
}

// --- SSRF protection -------------------------------------------------------
// Without this, the scraper would happily fetch internal addresses like
// http://localhost, your router at http://192.168.x.x, or the cloud metadata
// endpoint http://169.254.169.254 — a real risk for the LOCAL MCP server, which
// runs on your machine and network. We resolve each host and refuse any that
// map to a private, loopback, or link-local address.
//
// Residual risk: there is a small time-of-check/time-of-use gap because fetch()
// resolves DNS again itself, so a DNS-rebinding attacker could theoretically
// slip through. Fully closing that requires pinning the resolved IP on the
// socket, which is out of scope here.

const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed => refuse
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // unknown => refuse
}

/** Throw if the URL's host resolves to a private/internal address. */
async function assertPublicUrl(rawUrl: string): Promise<void> {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 [brackets]

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new ScrapeError(
        `Refusing to fetch a private or internal address (${host}).`
      );
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new ScrapeError(`Could not resolve the host "${host}".`);
  }
  if (addresses.length === 0) {
    throw new ScrapeError(`The host "${host}" did not resolve to any address.`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ScrapeError(
        `Refusing to fetch "${host}" because it resolves to a private or internal address (${address}).`
      );
    }
  }
}

/** Read a response body into a string, enforcing the byte cap while streaming. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments without a streaming body.
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new ScrapeError(`The page is larger than the ${maxBytes}-byte limit.`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new ScrapeError(
          `The page is larger than the ${maxBytes}-byte limit and was not downloaded.`
        );
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Fetch the raw HTML for a URL, with timeout, size, and SSRF guards. Redirects
 * are followed MANUALLY so every hop is re-validated — a public URL that
 * redirects to an internal address is blocked, not followed.
 */
async function fetchHtml(url: string, opts: ScrapeOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let redirects = 0; ; redirects++) {
      await assertPublicUrl(currentUrl); // re-check on every hop

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new ScrapeError(
            `The page took longer than ${timeoutMs} ms to respond and was aborted.`
          );
        }
        throw new ScrapeError(
          `Could not reach the page: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Handle redirects ourselves so each destination is SSRF-validated.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ScrapeError(
            `The server returned a redirect (HTTP ${response.status}) without a destination.`
          );
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new ScrapeError(
            `The page redirected too many times (more than ${MAX_REDIRECTS}).`
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new ScrapeError(
          `The server returned HTTP ${response.status} (${response.statusText}) for ${currentUrl}.`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        throw new ScrapeError(
          `That URL is not an HTML page (content-type: "${contentType}"). This tool only reads web pages.`
        );
      }

      return await readBody(response, maxBytes);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Build a configured Turndown (HTML → Markdown) converter. */
function buildTurndown(includeLinks: boolean): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx", // # Heading  (cleaner than underline style)
    codeBlockStyle: "fenced", // ```code``` blocks
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  // GitHub-flavoured Markdown: tables, strikethrough, task lists.
  service.use(gfm);

  // Drop things that never belong in clean text.
  service.remove(["script", "style", "noscript", "iframe", "form"]);

  if (!includeLinks) {
    // Replace <a href>text</a> with just "text".
    service.addRule("stripLinks", {
      filter: "a",
      replacement: (content) => content,
    });
  }

  return service;
}

/**
 * Build the fallback HTML used when Readability can't find an article. We clone
 * the <body> (so we don't disturb the document Readability is about to mutate)
 * and drop obvious chrome — nav, header, footer, aside — so even the fallback
 * stays reasonably clean rather than dumping the whole page.
 */
function extractFallbackHtml(dom: JSDOM): string {
  const body = dom.window.document.body;
  if (!body) return "";
  const clone = body.cloneNode(true) as typeof body;
  clone.querySelectorAll("nav, header, footer, aside").forEach((el) => el.remove());
  return clone.innerHTML;
}

/** Collapse runaway blank lines so the Markdown stays tidy. */
function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/\n{3,}/g, "\n\n") // no more than one blank line in a row
    .replace(/[ \t]+$/gm, "") // trim trailing whitespace on each line
    .trim();
}

/**
 * Turn a raw HTML string into a clean ScrapeResult. Shared by BOTH the fast
 * fetch path and the JavaScript-render path, so the cleaning logic lives in
 * exactly one place.
 */
function htmlToResult(
  url: string,
  html: string,
  options: ScrapeOptions
): ScrapeResult {
  // Parse the HTML into a DOM. Passing the URL lets Readability resolve
  // relative links and images correctly.
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // Readability DESTRUCTIVELY mutates the document while parsing, so capture a
  // cleaned copy of the body FIRST to use as a fallback if Readability bails.
  const fallbackHtml = extractFallbackHtml(dom);

  const reader = new Readability(document);
  const article = reader.parse();

  const includeLinks = options.includeLinks ?? true;
  const turndown = buildTurndown(includeLinks);

  // If Readability found an article, use its cleaned HTML. If not (some pages
  // aren't article-shaped), fall back to the cleaned <body> so we still return
  // something useful rather than failing.
  const contentHtml =
    article?.content && article.content.trim().length > 0
      ? article.content
      : fallbackHtml;

  if (!contentHtml.trim()) {
    throw new ScrapeError(
      "The page loaded but contained no readable text content to extract."
    );
  }

  const markdown = tidyMarkdown(turndown.turndown(contentHtml));
  const wordCount = markdown ? markdown.split(/\s+/).filter(Boolean).length : 0;

  return {
    url,
    title: article?.title ?? document.title ?? null,
    excerpt: article?.excerpt ?? null,
    siteName: article?.siteName ?? null,
    wordCount,
    markdown,
  };
}

/**
 * The public entry point. Give it a URL, get back clean Markdown + metadata.
 * Set options.renderJs to true to load the page in a real browser first.
 * Throws ScrapeError with a human-readable message on any failure.
 */
export async function scrapeUrl(
  rawUrl: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const url = normaliseUrl(rawUrl);
  // Guard both paths up front. (fetchHtml also re-checks every redirect hop.)
  await assertPublicUrl(url);

  const html = options.renderJs
    ? await renderHtml(url, {
        timeoutMs: options.timeoutMs,
        renderWaitMs: options.renderWaitMs,
      })
    : await fetchHtml(url, options);

  return htmlToResult(url, html, options);
}
