#!/usr/bin/env node
/**
 * release.mjs — ship a new version everywhere, in one command.
 *
 *   npm run release -- patch          # 1.1.1 -> 1.1.2
 *   npm run release -- minor          # 1.1.1 -> 1.2.0
 *   npm run release -- 2.0.0          # explicit version
 *   npm run release -- patch --skip-apify
 *   npm run release -- patch --dry     # show what would happen, change nothing
 *
 * The version lives in FOUR places that must stay in sync:
 *   1. package.json          version          (what npm publishes)
 *   2. server.json           version          (registry metadata)
 *   3. server.json           packages[].version (must match the npm version,
 *                                              or the registry rejects it)
 *   4. .actor/actor.json     version          (Apify, major.minor only)
 *
 * Order matters: npm must be live BEFORE the registry publish, because the
 * registry verifies the package version actually exists. Apify runs last so a
 * slow container build can't strand a half-finished release.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SKIP_APIFY = args.includes("--skip-apify");
const bumpArg = args.find((a) => !a.startsWith("--"));

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let step = 0;
const say = (msg) => console.log(`\n${c.bold(`[${++step}] ${msg}`)}`);
const info = (msg) => console.log(`    ${c.dim(msg)}`);
const ok = (msg) => console.log(`    ${c.green("OK")} ${msg}`);

function die(msg, hint) {
  console.error(`\n${c.red("FAILED")} ${msg}`);
  if (hint) console.error(`${c.yellow("  -> ")}${hint}`);
  process.exit(1);
}

/**
 * On Windows, npm/npx/apify are .cmd shims. Node refuses to spawn a .cmd
 * without a shell (it was closed off as a command-injection hole), so those
 * MUST go through one. Everything else — git, mcp-publisher.exe — is a real
 * executable and is spawned directly.
 *
 * When a shell IS used we pass one pre-joined string rather than an args array,
 * because a shell concatenates array args instead of escaping them (Node's
 * DEP0190). That's safe here only because every shelled command below uses
 * space-free arguments. Anything with spaces — notably `git commit -m` — takes
 * the direct, array-based path where Node handles the quoting.
 */
const WIN_SHIM = new Set(["npm", "npx", "apify", "vercel"]);

function run(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  const useShell = process.platform === "win32" && WIN_SHIM.has(cmd);
  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";

  if (useShell && cmdArgs.some((a) => /\s/.test(a))) {
    die(`Internal error: "${cmd}" was given an argument containing a space.`,
        "Shelled commands must use space-free arguments — see the comment above run().");
  }

  const r = useShell
    ? spawnSync([cmd, ...cmdArgs].join(" "), { cwd: ROOT, shell: true, stdio, encoding: "utf8" })
    : spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio, encoding: "utf8" });

  if (!allowFail && r.status !== 0) {
    // r.error is set when the process could not be started at all; without it
    // you just get "exited with null", which says nothing useful.
    const detail = r.error
      ? r.error.message
      : capture
        ? (r.stderr || "").trim().split("\n").slice(-3).join("\n")
        : undefined;
    die(`\`${cmd} ${cmdArgs.join(" ")}\` failed (exit ${r.status})`, detail);
  }
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Block the main thread. The script is strictly sequential, so this is fine. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function writeJson(p, obj) {
  if (DRY) return;
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------- version
function nextVersion(current, bump) {
  if (!bump) die("No version given.", "Use: npm run release -- patch | minor | major | 1.2.3");
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [maj, min, pat] = current.split(".").map(Number);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  die(`Unrecognised version "${bump}".`, "Use: patch | minor | major | an explicit 1.2.3");
}

const pkgPath = join(ROOT, "package.json");
const serverPath = join(ROOT, "server.json");
const actorPath = join(ROOT, ".actor", "actor.json");

const pkg = readJson(pkgPath);
const server = readJson(serverPath);
const from = pkg.version;
const to = nextVersion(from, bumpArg);

console.log(c.bold(`\nReleasing ${pkg.name}  ${from} -> ${to}`));
if (DRY) console.log(c.yellow("DRY RUN — nothing will be written, published, or pushed."));

// -------------------------------------------------------------- preflight
say("Preflight checks");

const dirty = run("git", ["status", "--porcelain"], { capture: true }).out;
if (dirty) {
  if (!DRY) {
    die("Working tree has uncommitted changes.",
        "Commit or stash them first so the release commit only contains the version bump.");
  }
  // Say what's actually true — a dry run that claims "clean" teaches you to
  // trust a check that never ran.
  console.log(`    ${c.yellow("WARN")} working tree is dirty (${dirty.split("\n").length} file(s)); a real release would stop here`);
} else {
  ok("working tree clean");
}

if (pkg.mcpName !== server.name) {
  die(`package.json mcpName (${pkg.mcpName}) != server.json name (${server.name}).`,
      "The registry rejects the publish unless these match exactly.");
}
ok(`registry name matches: ${server.name}`);

if ((server.description || "").length > 100) {
  die(`server.json description is ${server.description.length} chars; the registry caps it at 100.`);
}
ok(`description length ${(server.description || "").length}/100`);

// ------------------------------------------------------------ write files
say("Bumping version in all manifests");

pkg.version = to;
writeJson(pkgPath, pkg);
info(`package.json          -> ${to}`);

server.version = to;
for (const p of server.packages ?? []) p.version = to;
writeJson(serverPath, server);
info(`server.json           -> ${to} (and packages[].version)`);

if (existsSync(actorPath)) {
  const actor = readJson(actorPath);
  const actorVersion = to.split(".").slice(0, 2).join("."); // Apify uses major.minor
  actor.version = actorVersion;
  writeJson(actorPath, actor);
  info(`.actor/actor.json     -> ${actorVersion}`);
}

// ------------------------------------------------------------------ build
say("Building");
run("npm", ["run", "build"]);
ok("TypeScript compiled");

// ------------------------------------------------------------------ git
say("Committing and tagging");
if (DRY) {
  info(`would commit + tag v${to} + push`);
} else {
  run("git", ["add", "-A"]);
  run("git", ["-c", "core.safecrlf=false", "commit", "-q", "-m", `Release v${to}`]);
  run("git", ["tag", `v${to}`]);
  run("git", ["push", "-q", "origin", "main", "--follow-tags"]);
  ok(`pushed commit and tag v${to}`);
}

// ------------------------------------------------------------------ npm
say("Publishing to npm");
if (DRY) {
  info("would run: npm publish --access public");
} else {
  console.log(c.yellow("    npm may ask for a one-time password — approve it in the browser.\n"));
  run("npm", ["publish", "--access", "public"]);
  ok(`published ${pkg.name}@${to}`);
}

// ------------------------------------------ wait for npm to serve the version
// The registry verifies the npm version exists. Publishing is not instant, so
// poll rather than racing straight into a "version not found" rejection.
say("Waiting for npm to serve the new version");
if (DRY) {
  info("would poll npm until the version resolves");
} else {
  const deadline = Date.now() + 120_000;
  let seen = false;
  while (Date.now() < deadline) {
    const r = run("npm", ["view", `${pkg.name}@${to}`, "version"], {
      capture: true, allowFail: true,
    });
    if (r.status === 0 && r.out.includes(to)) { seen = true; break; }
    info("not visible yet, retrying in 5s...");
    sleep(5000);
  }
  if (!seen) {
    die("npm still isn't serving the new version after 2 minutes.",
        `Wait a moment, then finish with: .tools/mcp-publisher.exe publish`);
  }
  ok(`npm is serving ${to}`);
}

// -------------------------------------------------------------- registry
say("Publishing to the MCP Registry");
const publisher = existsSync(join(ROOT, ".tools", "mcp-publisher.exe"))
  ? ".tools\\mcp-publisher.exe"
  : "mcp-publisher";

if (DRY) {
  info(`would run: ${publisher} publish`);
} else {
  // NOTE: mcp-publisher's --dry-run actually publishes for real. Don't use it.
  const r = run(publisher, ["publish"], { capture: true, allowFail: true });
  if (r.status !== 0) {
    const blob = `${r.out}\n${r.err}`;
    if (/expired|Unauthorized|401/i.test(blob)) {
      die("Registry token expired.",
          `Run:  ${publisher} login github\nthen: ${publisher} publish`);
    }
    die("Registry publish failed.", blob.trim().split("\n").slice(-4).join("\n"));
  }
  ok(`registry updated to ${to}`);
}

// ----------------------------------------------------------------- apify
if (!SKIP_APIFY) {
  say("Deploying the Apify Actor");
  if (DRY) {
    info("would run: apify push --force --wait-for-finish=0");
  } else {
    const r = run("apify", ["push", "--force", "--wait-for-finish=0"], {
      capture: true, allowFail: true,
    });
    if (r.status !== 0) {
      // Non-fatal: npm + registry are already live, which is the hard part.
      console.log(`    ${c.yellow("WARN")} Apify push failed — npm and the registry are already updated.`);
      console.log(`    ${c.dim("Retry manually with: apify push --force")}`);
    } else {
      const id = (r.out.match(/Build ID:\s*(\S+)/) || [])[1];
      ok(`Apify build queued${id ? ` (${id})` : ""} — check with: apify builds ls`);
    }
  }
} else {
  console.log(`\n${c.yellow("Skipped Apify.")} The hosted Actor still runs the previous code.`);
}

// ---------------------------------------------------------------- summary
console.log(`\n${c.green(c.bold(`Released ${to}`))}`);
console.log(`  npm      https://www.npmjs.com/package/${pkg.name}`);
console.log(`  registry ${server.name}`);
console.log(`  repo     ${(pkg.repository?.url || "").replace(/^git\+/, "").replace(/\.git$/, "")}`);
if (!DRY) {
  console.log(c.dim("\nVerify the registry picked it up:"));
  console.log(c.dim(`  curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=${server.name}"`));
}
