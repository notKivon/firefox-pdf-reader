// Packaging for AMO: the XPI to upload, and the source archive AMO asks for
// because dist/ is bundled. Refuses to run on anything but a committed tree, so
// the source archive is exactly what the XPI was built from.

import { execFileSync } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const artifacts = join(root, "web-ext-artifacts");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

function fail(message) {
  console.error(`package — ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  fail(`manifest.json is ${manifest.version} but package.json is ${pkg.version}; make them agree.`);
}

if (read("git", ["status", "--porcelain"])) {
  fail("the working tree has uncommitted changes. Commit first, so the source archive matches the XPI.");
}

const version = manifest.version;
const commit = read("git", ["rev-parse", "--short", "HEAD"]);

run("npm", ["run", "build"]);
run("npm", ["run", "check:secrets"]); // CLAUDE.md: the gate before any packaging step
run("npx", ["web-ext", "lint", "--source-dir", "dist"]);

await rm(artifacts, { recursive: true, force: true });
run("npx", [
  "web-ext", "build",
  "--source-dir", "dist",
  "--artifacts-dir", artifacts,
  "--filename", `scholar-reader-${version}.zip`,
]);
const xpi = join(artifacts, `scholar-reader-${version}.xpi`);
await rename(join(artifacts, `scholar-reader-${version}.zip`), xpi);

// Tracked files only: no node_modules, no dist/, nothing gitignored.
const source = join(artifacts, `scholar-reader-${version}-source.zip`);
run("git", ["archive", "--format=zip", `--prefix=scholar-reader-${version}/`, "-o", source, "HEAD"]);

console.log(`\npackage — ${version} at ${commit}`);
console.log(`  upload:  ${relative(root, xpi)}`);
console.log(`  source:  ${relative(root, source)}`);
