// One real outline of a PDF, through the extension's own extraction, adapter
// and the running bridge, with the model choosing the sections:
//
//   node tools/extract-pdf.mjs paper.pdf --json /tmp/paper.json
//   node tools/paper-probe.mjs /tmp/paper.json [provider]
//
// Spends subscription usage (or Gemini quota). Reports where each section the
// model chose landed on the paper.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [file, providerId = "claude-opus"] = process.argv.slice(2);
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

const started = Date.now();
let updates = 0;
const result = await outline({
  sections, paper, providerId, meta: { title: sections[0]?.text.slice(0, 80) },
  resolveKey: async (ref) => store[ref] ?? null,
  onProgress: () => updates++,
});
console.log(`${providerId}: ${Math.round((Date.now() - started) / 1000)} s, ${updates} progress updates, ${result.sections.length} sections`);
console.log(`usage ${JSON.stringify(result.usage)}\nTL;DR: ${result.tldr}\n`);
for (const s of result.sections) {
  console.log(`p${s.page} y${Math.round(s.y)}  ${s.title}   ← "${s.heading}"`);
  for (const b of s.bullets) console.log(`     - ${b}`);
}
