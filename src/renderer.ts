/**
 * renderer.ts — optional JavaScript rendering with Playwright.
 *
 * Some sites build their content with JavaScript AFTER the page loads, so a
 * plain HTTP fetch (see scraper.ts) returns little or nothing. When a caller
 * asks for renderJs, we load the page in a real headless Chromium browser and
 * return the fully-rendered HTML, which then flows through the SAME cleaning
 * pipeline as the fetch path.
 *
 * Playwright is a HEAVY, OPTIONAL dependency (it needs a browser binary), so we
 * import it lazily. If it isn't installed, we throw a friendly message telling
 * the user how to enable this feature instead of crashing.
 *
 * SSRF note: scrapeUrl() validates the target URL before calling us. Playwright
 * still resolves DNS and follows redirects internally, so — as with the fetch
 * path — a determined DNS-rebinding attacker is not fully shut out. We block
 * images/media/fonts (for speed) but do not deep-inspect every sub-request.
 */

import { ScrapeError } from "./errors.js";

export interface RenderOptions {
  /** Max time to wait for the page, in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Extra wait after load for late content, in milliseconds. Default 0. */
  renderWaitMs?: number;
}

const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; clean-markdown-mcp/1.1; +https://apify.com/perforated_hummingbird/url-to-markdown)";

/**
 * Load a URL in headless Chromium and return its rendered HTML.
 * Throws ScrapeError (with install guidance) if Playwright is unavailable.
 */
export async function renderHtml(
  url: string,
  opts: RenderOptions = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const waitMs = opts.renderWaitMs ?? 0;

  // Lazy, indirect import so TypeScript doesn't hard-require Playwright at build
  // time and Node only loads it when JS rendering is actually requested.
  let chromium: any;
  try {
    const moduleName = "playwright";
    ({ chromium } = await import(moduleName));
  } catch {
    throw new ScrapeError(
      "JavaScript rendering needs Playwright, which isn't installed. Enable it with: " +
        "npm install playwright && npx playwright install chromium"
    );
  }

  let browser: any;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    // Skip heavy resources we never convert to Markdown — big speed win.
    await page.route("**/*", (route: any) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return route.abort();
      }
      return route.continue();
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (response && !response.ok()) {
      throw new ScrapeError(
        `The server returned HTTP ${response.status()} for ${url}.`
      );
    }

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    return await page.content();
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    if (err instanceof Error && /timeout/i.test(err.message)) {
      throw new ScrapeError(
        `The page took longer than ${timeoutMs} ms to render and was aborted.`
      );
    }
    throw new ScrapeError(
      `Could not render the page: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {
        /* ignore close errors */
      });
    }
  }
}
