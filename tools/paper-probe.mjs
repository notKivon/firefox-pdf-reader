// One real outline of a PDF, through the extension's own extraction, adapter
// and the running bridge, with the model choosing the sections:
//
//   node tools/extract-pdf.mjs paper.pdf --json /tmp/paper.json
//   node tools/paper-probe.mjs /tmp/paper.json [provider] [--pdf paper.pdf] [--port 8765]
//
// With --pdf, the PDF itself is sent, as the extension sends it.
//
// Spends subscription usage (or Gemini quota). Reports where each section the
// model chose landed on the paper.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [file, providerId = "claude-opus"] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const pdfPath = flag("--pdf");
const port = flag("--port");
const outPath = flag("--out");
const { sections, paper } = JSON.parse(readFileSync(file, "utf8"));
const token = readFileSync(join(homedir(), ".config", "scholar-reader", "bridge-token"), "utf8").trim();
const store = { "claude-bridge": token };
globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers ?? {}), Origin: "moz-extension://probe" } });
const { installIndexedDb } = await import("./test/idb.mjs");
installIndexedDb();
const { outline } = await import("../src/model/adapter.js");
const { PROVIDERS } = await import("../src/model/providers.js");
if (port && PROVIDERS[providerId].bridge) PROVIDERS[providerId].baseUrl = `http://127.0.0.1:${port}/v1/`;
const pdf = pdfPath ? { data: new Uint8Array(readFileSync(pdfPath)), pages: Number(flag("--pages") ?? 0) || null } : null;
if (pdf && !pdf.pages) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdf.pages = (await getDocument({ data: pdf.data.slice(), verbosity: 0 }).promise).numPages;
}

const started = Date.now();
let updates = 0;
const result = await outline({
  sections, paper, pdf, providerId, meta: { title: sections[0]?.text.slice(0, 80) },
  resolveKey: async (ref) => store[ref] ?? null,
  onProgress: () => updates++,
});
console.log(`${providerId}: ${Math.round((Date.now() - started) / 1000)} s, ${updates} progress updates, ${result.sections.length} sections`);
console.log(`usage ${JSON.stringify(result.usage)}\nTL;DR: ${result.tldr}\n`);
// Where each bullet's jump would land, as the viewer computes it: by its quote,
// by its own words (the older way, kept as the fallback), or at the heading.
const { anchorSections, bodiesOf } = await import("../src/extract/anchor.js");
const { locateQuote } = await import("../src/viewer/locate-quote.js");
const { locateBullet } = await import("../src/viewer/locate.js");
const bodies = bodiesOf(anchorSections(result.sections, paper).sections, paper);
const tally = { quote: 0, words: 0, heading: 0, wordsAlone: 0, total: 0 };
result.sections.forEach((s, i) => {
  s.bullets.forEach((b, j) => {
    const lines = bodies[i]?.lines ?? [];
    const q = s.quotes?.[j] && locateQuote(s.quotes[j], lines);
    const w = locateBullet(b, lines);
    tally.total++;
    if (w) tally.wordsAlone++;
    if (q) tally.quote++;
    else if (w) tally.words++;
    else tally.heading++;
  });
});
console.log(`jumps: ${tally.quote} by quote, ${tally.words} by words, ${tally.heading} to the heading, of ${tally.total}` +
  ` — words alone would place ${tally.wordsAlone}\n`);
if (outPath) (await import("node:fs")).writeFileSync(outPath, JSON.stringify({ result, tally }, null, 1));
for (const s of result.sections) {
  console.log(`p${s.page} y${Math.round(s.y)}  ${s.title}   ← "${s.heading}"${s.unplaced ? "  [UNPLACED]" : ""}`);
  for (const b of s.bullets) console.log(`     - ${b}`);
}
