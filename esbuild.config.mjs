import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as esbuild from "esbuild";

const root = dirname(new URL(import.meta.url).pathname);
const out = resolve(root, "dist");

// Files copied verbatim into dist/, as [source, destination-relative-to-dist].
// Extension pages are referenced flat from the manifest, so they land at the root.
const STATIC = [
  ["manifest.json", "manifest.json"],
  ["src/viewer/viewer.html", "viewer.html"],
];

async function copyStatic() {
  await mkdir(out, { recursive: true });
  for (const [from, to] of STATIC) {
    await cp(resolve(root, from), resolve(out, to), { recursive: true });
  }
}

// Runs after every build, so watch mode picks up HTML and manifest edits too.
const staticAssets = {
  name: "static-assets",
  setup(build) {
    build.onEnd(copyStatic);
  },
};

const options = {
  entryPoints: {
    background: "src/background/index.js",
    viewer: "src/viewer/viewer.js",
  },
  outdir: out,
  bundle: true,
  // iife, not esm: an MV3 background script loads as a classic script unless the
  // manifest opts into modules, and everything is bundled anyway.
  format: "iife",
  target: "firefox128",
  platform: "browser",
  sourcemap: true,
  logLevel: "info",
  plugins: [staticAssets],
};

const watch = process.argv.includes("--watch");

await rm(out, { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(options);
}
