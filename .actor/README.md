# URL to Clean Markdown — LLM-Ready Text Extractor

Turn any web page into **clean, readable Markdown**. Give it a URL, get back just
the content — no ads, no navigation bars, no cookie banners, no scripts.

Built for feeding web content to AI models, where junk in the input means junk in
the output.

---

## Why use this

Most scrapers hand you raw HTML and leave the cleanup to you. This one does the
cleanup:

- **Readable output, not HTML soup.** Uses Mozilla's Readability engine — the
  same technology behind Firefox's Reader View — to find the actual article and
  throw away the rest.
- **Proper Markdown.** Headings, lists, tables, code blocks, and links are all
  preserved in GitHub-flavoured Markdown, ready to paste into a prompt.
- **Handles modern sites.** Flip on **Render JavaScript** and the page loads in a
  real browser first, so content built by JavaScript is captured too.
- **Batch friendly.** Pass a list of URLs and get one clean record per page.
- **You only pay for what works.** Failed pages are recorded so you can see what
  happened — and you are never charged for them.

## Great for

- Feeding articles and documentation into **LLMs, RAG pipelines, and AI agents**
- Building **research and knowledge bases** from web sources
- **Content archiving** in a durable, human-readable format
- Turning docs sites into clean Markdown for **training or reference data**

---

## Input

| Field | Type | Description |
| --- | --- | --- |
| `startUrls` | array | One or more page URLs to convert. Each successful page is charged once. |
| `url` | string | Shortcut for a single page. Can be used instead of, or alongside, `startUrls`. |
| `renderJs` | boolean | Load each page in a real browser so JavaScript-built content is captured. Slower. Default `false`. |
| `renderWaitMs` | integer | With `renderJs` on, wait this many extra milliseconds after load for late content. Default `0`. |
| `includeLinks` | boolean | Keep hyperlinks in the Markdown. Turn off for cleaner plain prose. Default `true`. |

**Example input**

```json
{
  "startUrls": [
    "https://en.wikipedia.org/wiki/Markdown",
    "https://example.com"
  ],
  "renderJs": false,
  "includeLinks": true
}
```

## Output

One dataset record per page:

```json
{
  "url": "https://en.wikipedia.org/wiki/Markdown",
  "title": "Markdown",
  "excerpt": "Markdown is a lightweight markup language...",
  "siteName": "Wikimedia Foundation, Inc.",
  "wordCount": 3092,
  "markdown": "Markdown is a lightweight markup language for creating formatted text...",
  "scrapedAt": "2026-07-23T20:31:00.000Z"
}
```

If a page can't be scraped, you get a record with an `error` field explaining
why — and that page is **not** charged.

---

## Pricing

Pay per event — you are charged **once per page successfully scraped**. No
subscription, and **failed pages are never charged**.

| What you run | Charged as |
| --- | --- |
| Standard scrape (default) | Page scraped — the low rate |
| With **Render JavaScript** on | Page rendered — a higher rate |

Rendering runs a real browser and uses far more computing power, so it's priced
separately. If you don't turn it on, you never pay the rendering rate.

---

## When to turn on "Render JavaScript"

Leave it **off** by default — it's faster and works for most articles, blogs,
documentation, and news sites.

Turn it **on** when a page comes back nearly empty. That usually means the site
builds its content with JavaScript after loading. The difference on such a page
is dramatic:

| Mode | Result on a JavaScript-built page |
| --- | --- |
| Default (off) | ~3 words — just navigation links |
| Render JavaScript (on) | ~190 words — the full content |

---

## Good to know

- Only `http` and `https` pages are supported.
- Pages are capped at 5 MB and time out after 20 seconds (30 with rendering) to
  keep runs fast and predictable.
- Internal and private network addresses are refused for security.
- A small number of sites block automated traffic; that's a site policy, and
  those pages will be reported as errors rather than charged.
