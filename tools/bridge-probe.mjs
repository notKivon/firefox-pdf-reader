// One real outline through the running bridge, end to end through the
// extension's own adapter: `node tools/bridge-probe.mjs [fixture] [provider]`.
// Spends subscription usage; the unit tests in tools/test/bridge.test.mjs don't.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [fixture = "adam", providerId = "claude-opus"] = process.argv.slice(2);
const token = readFileSync(join(homedir(), ".config", "scholar-reader", "bridge-token"), "utf8").trim();

globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers ?? {}), Origin: "moz-extension://probe" } });

const { installIndexedDb } = await import("./test/idb.mjs");
installIndexedDb();
const { outline } = await import("../src/model/adapter.js");

const doc = JSON.parse(readFileSync(new URL(`../fixtures/${fixture}.json`, import.meta.url), "utf8"));
const started = Date.now();
let partials = 0;
const result = await outline({
  sections: doc.sections,
  providerId,
  resolveKey: async () => token,
  meta: { title: doc.name ?? fixture },
  onProgress: () => partials++,
});

const bullets = result.sections.flatMap((s) => s.bullets.map((b) => ({ section: s, bullet: b })));
const words = bullets.map(({ bullet }) => bullet.split(/\s+/).length);
console.log(`${providerId} on ${fixture}: ${Math.round((Date.now() - started) / 1000)} s, ${partials} progress updates`);
console.log(`sections ${result.sections.length}, bullets ${bullets.length}, words/bullet median ${median(words)} max ${Math.max(...words)}`);
console.log(`usage ${JSON.stringify(result.usage)}`);
console.log(`\nTL;DR: ${result.tldr}\n`);
for (const s of result.sections.slice(0, 4)) console.log(`${s.title}\n${s.bullets.map((b) => `  - ${b}`).join("\n")}`);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
