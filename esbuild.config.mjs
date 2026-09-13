import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as esbuild from "esbuild";

const root = dirname(new URL(import.meta.url).pathname);
const out = resolve(root, "dist");

// Files copied verbatim into dist/, as [source, destination-relative-to-dist].
// Extension pages are referenced flat from the manifest, so they land at the root.
const pdfjs = (path) => `node_modules/pdfjs-dist/${path}`;

const STATIC = [
  ["manifest.json", "manifest.json"],
  ["src/viewer/viewer.html", "viewer.html"],
  ["src/viewer/theme.css", "theme.css"],
  ["src/viewer/controls.css", "controls.css"],
  ["src/viewer/debug.css", "debug.css"],
  ["src/viewer/outline.css", "outline.css"],
  ["src/settings/settings.html", "settings.html"],
  ["src/settings/settings.css", "settings.css"],
  // pdf.js ships its viewer CSS and the images that CSS references side by
  // side; the relative url(images/...) only resolves if both land flat.
  [pdfjs("web/pdf_viewer.css"), "pdf_viewer.css"],
  [pdfjs("web/images"), "images"],
  // Copied, not bundled: pdf.js spawns it with `new Worker(src, {type:"module"})`.
  // Its sourcemap comes along or devtools 404s on every worker load.
  [pdfjs("build/pdf.worker.mjs"), "pdf.worker.mjs"],
  [pdfjs("build/pdf.worker.mjs.map"), "pdf.worker.mjs.map"],
  // Data pdf.js fetches at runtime. Bundled so the viewer works offline and
  // never reaches a CDN.
  [pdfjs("cmaps"), "cmaps"],
  [pdfjs("standard_fonts"), "standard_fonts"],
  [pdfjs("wasm"), "wasm"],
  [pdfjs("iccs"), "iccs"],
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
    settings: "src/settings/settings.js",
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
