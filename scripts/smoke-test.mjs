#!/usr/bin/env node
/**
 * smoke-test.mjs — prove the built server actually speaks MCP before we publish.
 *
 * Spawns dist/index.js exactly like a real client would (Claude Desktop, Cursor),
 * performs the JSON-RPC handshake over stdio, lists tools, then calls scrape_url.
 *
 * Run with:  node scripts/smoke-test.mjs
 *
 * The handshake checks are HARD failures — if they break, the package is broken
 * for everyone. The live scrape is a SOFT failure: it depends on a third-party
 * site being reachable, and a release shouldn't be blocked by someone else's
 * downtime. A real regression in scraping shows up in the handshake-level checks
 * (the tool erroring) rather than in the site being unreachable.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const TIMEOUT_MS = 60_000;

if (!existsSync(SERVER)) {
  console.error(`FAIL: ${SERVER} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const send = (method, params) => {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
};
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

let softFailures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const warn = (m) => { softFailures++; console.log(`  WARN  ${m}`); };

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  if (stderr.trim()) console.error(`\n--- server stderr ---\n${stderr.trim()}`);
  child.kill();
  process.exit(1);
}

const guard = setTimeout(() => fail(`timed out after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

console.log("MCP smoke test");

// 1. Handshake
const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "1.0.0" },
});
const serverInfo = init.result?.serverInfo;
if (!serverInfo?.name) fail("initialize did not return serverInfo");
pass(`initialize -> ${serverInfo.name} v${serverInfo.version}`);

notify("notifications/initialized", {});

// 2. Tool discovery
const tools = await send("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
if (!names.includes("scrape_url")) {
  fail(`tools/list did not expose scrape_url (got: ${names.join(", ") || "none"})`);
}
pass(`tools/list -> ${names.join(", ")}`);

// 3. Real call. Soft-fails on network trouble; hard-fails on a broken tool.
const called = await send("tools/call", {
  name: "scrape_url",
  arguments: { url: "https://example.com" },
});
const text = called.result?.content?.[0]?.text ?? "";

if (called.result?.isError) {
  if (/reach|resolve|timed out|HTTP \d/i.test(text)) {
    warn(`scrape_url could not reach the network: ${text.split("\n")[0]}`);
  } else {
    fail(`scrape_url returned an error: ${text.split("\n")[0]}`);
  }
} else if (!text.includes("Example Domain")) {
  fail(`scrape_url returned unexpected content: ${text.slice(0, 120)}`);
} else {
  pass(`tools/call -> ${text.split("\n")[0]}`);
}

clearTimeout(guard);
child.kill();

console.log(
  softFailures
    ? `\nPassed with ${softFailures} warning(s).`
    : "\nAll checks passed."
);
process.exit(0);
