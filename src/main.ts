/**
 * main.ts — the Apify Actor entry point.
 *
 * On Apify, an "Actor" is a cloud program that takes JSON input, does work, and
 * writes results to a dataset. This Actor accepts one OR many URLs, calls the
 * SAME scrapeUrl() engine the MCP server uses, and charges one pay-per-event
 * charge PER successfully scraped page.
 *
 * Run locally with:  npm run actor   (with a local INPUT.json in
 * ./storage/key_value_stores/default/)
 */

import { Actor } from "apify";
import { scrapeUrl, ScrapeError } from "./scraper.js";

interface ActorInput {
  /** A single URL (kept for convenience / backward compatibility). */
  url?: string;
  /** A list of URLs to scrape in one run. */
  startUrls?: string[];
  /** Keep hyperlinks in the Markdown output. Default true. */
  includeLinks?: boolean;
  /** Render each page in a real browser so JS-built content is captured. */
  renderJs?: boolean;
  /** Extra wait (ms) after load when renderJs is on. */
  renderWaitMs?: number;
}

// These names MUST match the events you create in the Apify Console.
// Rendering a page in a real browser costs far more compute than a plain fetch,
// so it is charged as its own, higher-priced event. Customers who don't use
// JavaScript rendering are never charged the rendering price.
const EVENT_PAGE_SCRAPED = "page-scraped";
const EVENT_PAGE_RENDERED = "page-rendered";

await Actor.init();

try {
  const input = (await Actor.getInput<ActorInput>()) ?? {};

  // Gather URLs from both `url` and `startUrls`, de-duplicated, order preserved.
  const urls = [
    ...(input.url ? [input.url] : []),
    ...(input.startUrls ?? []),
  ]
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean);
  const uniqueUrls = [...new Set(urls)];

  if (uniqueUrls.length === 0) {
    throw new ScrapeError(
      'No URLs given. Provide "url" (a single page) or "startUrls" (a list of pages).'
    );
  }

  const renderJs = input.renderJs ?? false;
  // Browser rendering is the expensive path, so it bills against its own event.
  const eventName = renderJs ? EVENT_PAGE_RENDERED : EVENT_PAGE_SCRAPED;

  let succeeded = 0;
  let failed = 0;
  let budgetReached = false;

  for (const url of uniqueUrls) {
    try {
      const result = await scrapeUrl(url, {
        includeLinks: input.includeLinks ?? true,
        renderJs,
        renderWaitMs: input.renderWaitMs,
      });

      // Deliver the result FIRST, then charge — so we never bill for a page we
      // failed to hand over.
      await Actor.pushData({
        url: result.url,
        title: result.title,
        excerpt: result.excerpt,
        siteName: result.siteName,
        wordCount: result.wordCount,
        markdown: result.markdown,
        scrapedAt: new Date().toISOString(),
      });

      const charge = await Actor.charge({ eventName });
      succeeded++;

      // Respect the buyer's spending cap: stop once Apify says the limit is hit.
      if (charge?.eventChargeLimitReached) {
        budgetReached = true;
        await Actor.setStatusMessage(
          "Stopped early: the run's charging limit was reached."
        );
        break;
      }
    } catch (err) {
      failed++;
      const message =
        err instanceof ScrapeError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      // Record the failure (not charged) so the caller can see what went wrong.
      await Actor.pushData({
        url,
        error: message,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  await Actor.setStatusMessage(
    `Done. Scraped ${succeeded} page(s), ${failed} failed` +
      (budgetReached ? " (stopped at charge limit)." : ".")
  );

  await Actor.exit();
} catch (err) {
  // Only reached for input-level problems (e.g. no URLs at all).
  const message =
    err instanceof ScrapeError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  await Actor.fail(message);
}
