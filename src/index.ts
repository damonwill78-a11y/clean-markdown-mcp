#!/usr/bin/env node
/**
 * index.ts — the MCP server.
 *
 * This wraps the scraper (src/scraper.ts) as a Model Context Protocol server
 * that talks over stdio. Any MCP client (Claude Desktop, Cursor, etc.) can
 * launch this process and call the `scrape_url` tool.
 *
 * Run it with:  node dist/index.js
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scrapeUrl, ScrapeError } from "./scraper.js";

// Read the version at runtime rather than hardcoding it — a literal here goes
// stale the moment a release bumps package.json, and nothing would catch it.
// (npm always ships package.json, so this resolves for installed users too.)
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "url-to-markdown",
  version,
});

server.registerTool(
  "scrape_url",
  {
    title: "Scrape URL to Markdown",
    description:
      "Fetch any web page and return its main content as clean, readable Markdown. " +
      "Strips out navigation, ads, cookie banners, scripts, and other boilerplate. " +
      "Ideal for feeding article or documentation content to an LLM.",
    inputSchema: {
      url: z
        .string()
        .describe("The full URL of the web page to scrape (must start with http:// or https://)."),
      includeLinks: z
        .boolean()
        .optional()
        .describe(
          "Keep hyperlinks in the output (default true). Set to false for cleaner plain prose."
        ),
      renderJs: z
        .boolean()
        .optional()
        .describe(
          "Render the page in a real browser first (default false). Use for sites whose content is built by JavaScript. Requires Playwright to be installed."
        ),
    },
  },
  async ({ url, includeLinks, renderJs }) => {
    try {
      const result = await scrapeUrl(url, { includeLinks, renderJs });

      // Present a small header of metadata followed by the Markdown body.
      const header = [
        result.title ? `# ${result.title}` : null,
        result.siteName ? `**Source:** ${result.siteName}` : null,
        `**URL:** ${result.url}`,
        `**Words:** ${result.wordCount}`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n---\n\n${result.markdown}`,
          },
        ],
      };
    } catch (err) {
      const message =
        err instanceof ScrapeError
          ? err.message
          : `Unexpected error while scraping: ${err instanceof Error ? err.message : String(err)}`;
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: never write to stdout here — stdout is the MCP channel.
  // Use stderr for any human-facing log lines.
  console.error("url-to-markdown MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
