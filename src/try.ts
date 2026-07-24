/**
 * try.ts — a dead-simple local tester.
 *
 * This is NOT part of the MCP server or the Actor. It just lets you paste a URL
 * and see the Markdown printed to your terminal, so you can confirm the engine
 * works before wiring up anything else.
 *
 * Usage:  node dist/try.js https://example.com
 *         node dist/try.js https://quotes.toscrape.com/js/ --render
 *
 * Add --render to load the page in a real browser first (needs Playwright).
 */

import { scrapeUrl, ScrapeError } from "./scraper.js";

async function main() {
  const args = process.argv.slice(2);
  const renderJs = args.includes("--render");
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("Usage: node dist/try.js <url> [--render]");
    console.error("Example: node dist/try.js https://en.wikipedia.org/wiki/Markdown");
    process.exit(1);
  }

  try {
    const result = await scrapeUrl(url, { renderJs, renderWaitMs: renderJs ? 500 : 0 });
    console.log("==== METADATA ====");
    console.log("Title:    ", result.title);
    console.log("Site:     ", result.siteName);
    console.log("Words:    ", result.wordCount);
    console.log("\n==== MARKDOWN ====\n");
    console.log(result.markdown);
  } catch (err) {
    if (err instanceof ScrapeError) {
      console.error("Could not scrape:", err.message);
    } else {
      console.error("Unexpected error:", err);
    }
    process.exit(1);
  }
}

main();
