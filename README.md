# clean-markdown-mcp

An [MCP](https://modelcontextprotocol.io) server that turns any URL into **clean,
LLM-ready Markdown** — no ads, no nav bars, no cookie banners, no scripts.

Built for RAG pipelines and AI agents, where junk in the input means junk in the
output.

```
Give it:  https://en.wikipedia.org/wiki/Markdown
Get back: # Markdown

          Markdown is a lightweight markup language for creating
          formatted text using a plain-text editor...
```

## Install

```bash
npm install -g clean-markdown-mcp
```

## Use it with Claude Desktop

Add this to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "clean-markdown": {
      "command": "npx",
      "args": ["-y", "clean-markdown-mcp"]
    }
  }
}
```

Restart Claude Desktop, then ask it to *"scrape https://example.com to Markdown."*

Works the same way in Cursor, Windsurf, or any other MCP client — point it at the
`clean-markdown-mcp` command.

## The tool it exposes

**`scrape_url`**

| Parameter | Type | Description |
| --- | --- | --- |
| `url` | string | The page to scrape. Must be `http://` or `https://`. |
| `includeLinks` | boolean | Keep hyperlinks in the Markdown. Default `true`. Set `false` for cleaner prose. |
| `renderJs` | boolean | Load the page in a real browser first, for JavaScript-built sites. Default `false`. Requires Playwright — see below. |

Returns the page title, source, word count, and the clean Markdown.

## How the cleaning works

1. **Fetch** — with a 20-second timeout, a 5 MB size cap, and redirects validated
   at every hop.
2. **Clean** — runs [Mozilla Readability](https://github.com/mozilla/readability),
   the engine behind Firefox Reader View, to isolate the real article and discard
   navigation, sidebars, ads, and comment sections.
3. **Convert** — [Turndown](https://github.com/mixmark-io/turndown) renders it as
   GitHub-flavoured Markdown, preserving headings, lists, tables, and code blocks.

If a page isn't article-shaped, it falls back to a cleaned `<body>` rather than
failing, so you still get usable text.

## JavaScript-heavy sites (optional)

Some sites build their content with JavaScript after loading. A plain fetch
returns almost nothing for those. To handle them, install Playwright once:

```bash
npm install playwright && npx playwright install chromium
```

Then pass `renderJs: true`. The difference on such a page is dramatic:

| Mode | Result |
| --- | --- |
| Default | ~3 words — just navigation links |
| `renderJs: true` | ~190 words — the full content |

Playwright is **not** a dependency of this package, so a normal install stays
small and fast. Without it, `renderJs` returns a clear message telling you how to
enable it.

## Security

The scraper refuses private, loopback, and link-local addresses — including cloud
metadata endpoints like `169.254.169.254` — and re-validates every redirect hop.
This matters because an MCP server runs on your machine, with access to your
local network.

## Need to scrape at scale?

This package handles one page at a time, locally. For **batch scraping**,
**hosted JavaScript rendering**, and a pay-per-page API with no infrastructure to
run, the same engine is available as a hosted Actor:

**https://apify.com/perforated_hummingbird/url-to-markdown**

## Known limitations

- Some sites block automated traffic. That's a site policy, not a bug here.
- Non-UTF-8 pages may render with garbled characters.
- No `robots.txt` enforcement — you are responsible for how you use it.

## Local development

```bash
npm install
npm run build
node dist/try.js https://example.com          # quick test
node dist/try.js https://example.com --render # with JS rendering
```

## License

MIT
