// Runs the extension's own extraction (src/extract/) on a PDF, in Node:
//
//   node tools/extract-pdf.mjs path/to/paper.pdf [--json out.json] [--lines]
//
// The same pipeline viewer.js runs — text layer, column layout, sections — so a
// bad outline can be reproduced from the file alone. The one substitution is
// pdf.js itself: the viewer's wrapper (src/viewer/pdfjs.js) also loads the
// browser viewer, which needs a DOM, so the bundle here swaps in pdf.js's
// Node build. Nothing else is stubbed.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/extract-pdf.mjs paper.pdf [--json out.json] [--lines]");
  process.exit(2);
}
const jsonOut = rest.includes("--json") ? rest[rest.indexOf("--json") + 1] : null;

const entry = `
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { charsPerPage, extractPages, modalFontName } from "./src/extract/textlayer.js";
import { layoutDocument } from "./src/extract/columns.js";
import { extractSections } from "./src/extract/sections.js";
export async function run(bytes) {
  const doc = await getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = await extractPages(doc, {});
  const laid = layoutDocument(pages);
  const result = await extractSections(doc, laid, {
    bodyHeight: laid.bodyHeight,
    bodyFont: modalFontName(pages),
    charsPerPage: charsPerPage(pages),
  });
  return { doc, laid, result, numPages: doc.numPages };
}`;

// Inside the project, so the bundle resolves pdfjs-dist from node_modules.
const dir = join(process.cwd(), "node_modules", ".cache", "extract-pdf");
mkdirSync(dir, { recursive: true });
const out = join(dir, `run-${process.pid}.mjs`);
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error",
  external: ["pdfjs-dist/*"],
  plugins: [
    {
      name: "node-pdfjs",
      setup(b) {
        b.onResolve({ filter: /viewer\/pdfjs\.js$/ }, () => ({ path: "node-pdfjs", namespace: "shim" }));
        b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
          contents: 'import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"; export { pdfjsLib };',
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

const { run } = await import(out);
const { laid, result, numPages } = await run(new Uint8Array(readFileSync(file)));
const { sections, source } = result;
console.log(`verdict ${JSON.stringify(laid.verdict)}`);
console.log(`${numPages} pages · path ${source} · ${sections.length} sections · body height ${laid.bodyHeight?.toFixed?.(2)}`);
for (const [i, s] of sections.entries()) {
  console.log(`${String(i).padStart(2)}  p${s.page}  ${s.text.length.toString().padStart(6)} chars  ${JSON.stringify(s.title)}`);
}
if (rest.includes("--lines")) {
  for (const page of laid.pages) {
    console.log(`\n=== page ${page.pageNumber} (${page.columnCount} col, boundary ${page.boundary?.toFixed?.(1)}) ===`);
    for (const line of page.lines) console.log(`  [${line.height.toFixed(1)} ${line.fontName} c${line.column}] ${line.str}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ sections, source, paper: result.paper }, null, 1));
