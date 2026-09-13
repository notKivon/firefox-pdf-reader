// Verification gate: fail if a provider API key reached the built bundle, or a
// tracked source file. Run before any packaging or signing step (see the secrets
// policy in CLAUDE.md).

import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const dist = resolve(root, "dist");

// Key-shaped matches fail the build. `AIza` is Google's key prefix and does not
// occur naturally; a bare `sk-` does occur inside ordinary words ("task-", "risk-"),
// so only the key-shaped form fails and the rest is reported as a warning.
const FATAL = [
  { label: "Google API key", re: /AIza[0-9A-Za-z_-]{10,}/g },
  { label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
];
const WARN = [{ label: "bare 'sk-'", re: /\bsk-/g }];

// Tracked sources are held to full-length keys only: a real Google key is `AIza`
// plus 35 characters, and the tests deliberately use short fake ones.
const SOURCE_FATAL = [
  { label: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{32,}/g },
];

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    return out.split("\0").filter(Boolean).map((f) => join(root, f));
  } catch {
    return null; // not a git checkout — nothing tracked to scan
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function locate(text, index) {
  const line = text.slice(0, index).split("\n").length;
  return line;
}

async function main() {
  if (!(await stat(dist).catch(() => null))) {
    console.error("check:secrets — no dist/ to check. Run `npm run build` first.");
    process.exit(1);
  }

  const failures = [];
  const warnings = [];

  for await (const path of walk(dist)) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue; // binary asset
    const rel = relative(root, path);

    for (const { label, re } of FATAL) {
      for (const m of text.matchAll(re)) {
        failures.push(`${rel}:${locate(text, m.index)} — ${label}: ${m[0].slice(0, 12)}…`);
      }
    }
    for (const { label, re } of WARN) {
      for (const m of text.matchAll(re)) {
        const shaped = FATAL.some((f) => new RegExp(f.re.source).test(m[0]));
        if (!shaped) warnings.push(`${rel}:${locate(text, m.index)} — ${label}`);
      }
    }
  }

  const tracked = trackedFiles();
  for (const path of tracked ?? []) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    for (const { label, re } of SOURCE_FATAL) {
      for (const m of text.matchAll(re)) {
        failures.push(`${relative(root, path)}:${locate(text, m.index)} — ${label}: ${m[0].slice(0, 12)}…`);
      }
    }
  }
  if (tracked === null) console.warn("  warn  not a git checkout — tracked sources were not scanned");

  for (const w of warnings.slice(0, 10)) console.warn(`  warn  ${w}`);
  if (warnings.length > 10) console.warn(`  warn  …and ${warnings.length - 10} more`);

  if (failures.length) {
    console.error(`check:secrets — FAILED, ${failures.length} match(es):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(`check:secrets — clean, no API keys in dist/ or ${tracked?.length ?? 0} tracked files`);
}

await main();
