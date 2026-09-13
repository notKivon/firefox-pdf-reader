// Step 13: the production provider, end to end through the real router.
//
// Spends real quota (~1–5¢ a paper on gemini-prod). Run it by hand:
//
//   node tools/prod-check.mjs                    # gpt3, the 32-section stress case
//   node tools/prod-check.mjs --fixture adam,bert
//   node tools/prod-check.mjs --all              # every fixture, then a total
//
// Unlike `live-probe.mjs`, which calls the adapter, this goes through
// `background/router.js` exactly as a viewer message would — `plan`, the consent
// gate, `runOutline`, the cache write, and a reopen — so what it asserts is what
// the extension does, not what one module does. Per fixture it checks:
//   1. before consent, `outline` is refused and nothing is fetched;
//   2. after consent, the run costs exactly ONE request and moves the quota
//      counter by exactly 1;
//   3. progress messages reach the tab while the response is still streaming,
//      spread over the run rather than bunched at the end;
//   4. a reopen is a cache hit: zero fetches, counter unchanged;
// and then prints the quality report (probe-report.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { installIndexedDb } from "./test/idb.mjs";
import { measure, report } from "./probe-report.mjs";

installIndexedDb();

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const providerId = flag("provider") ?? "gemini-prod";
const fixtures = args.includes("--all")
  ? readdirSync(new URL("../fixtures/", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
  : (flag("fixture") ?? "gpt3").split(",");

const keyFile = process.env.SCHOLAR_READER_KEY_FILE ?? `${homedir()}/.config/scholar-reader/gemini.key`;
let apiKey;
try {
  apiKey = readFileSync(keyFile, "utf8").trim();
  if (!apiKey) throw new Error("the file is empty");
} catch (err) {
  console.error(`No API key at ${keyFile} (${err.message}).`);
  process.exit(2);
}

// The browser surface the router touches: the key in storage.local, exactly
// where the settings page will put it, and a tab that records what it is sent.
const progress = [];
globalThis.browser = {
  storage: { local: { get: async (k) => (k === "apiKeys" ? { apiKeys: { gemini: apiKey } } : {}) } },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async (_tab, message) => { progress.push({ at: Date.now(), message }); } },
};
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (...a) => { fetches++; return realFetch(...a); };

const { plan, runOutline } = await import("../src/background/router.js");
const { grantConsent } = await import("../src/store/consent.js");
const { used } = await import("../src/store/quota.js");

const totals = { papers: 0, sections: 0, bullets: 0, outside: 0, long: 0, thirds: [0, 0, 0], perThird: [0, 0, 0],
  numeric: 0, kept: 0, tldrOver2: 0, requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };

for (const name of fixtures) {
  const { sections, meta } = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  const sendable = sections.filter((s) => s.text.trim());
  // A stand-in identity: fixtures carry no PDF bytes, and each needs its own key.
  const hash = createHash("sha256").update(`prod-check:${name}`).digest("hex");
  const request = { hash, sections, meta: { title: meta?.title ?? name, pageCount: meta?.pageCount ?? 0 }, providerId };

  console.log(`\n##### ${name}: ${sendable.length} sections, ${sendable.reduce((n, s) => n + s.text.length, 0)} chars → ${providerId}`);

  // 1. Unconsented: refused, nothing sent.
  const detail = await plan(request);
  assert.equal(detail.consented, false);
  const refused = await runOutline(request, 1);
  assert.equal(refused.error, "consent-required");
  assert.equal(fetches, 0, "an unconsented outline must fetch nothing");

  // 2. Consented: one request, counter +1.
  await grantConsent(detail);
  const before = await used(providerId);
  progress.length = 0;
  const started = Date.now();
  const result = await runOutline(request, 1);
  const finished = Date.now();
  if (result.error) {
    console.error(`run failed: ${result.error} — ${result.message ?? ""}`);
    process.exit(1);
  }
  assert.equal(fetches, 1, `whole-document must be one request, saw ${fetches}`);
  assert.equal(result.usage.requests, 1);
  const delta = (await used(providerId)) - before;
  assert.equal(delta, 1, `quota counter moved by ${delta}`);

  // 3. Progressive fill, measured as when each additional section arrived.
  const fills = progress.filter((p) => Array.isArray(p.message.sections));
  const firstAt = fills[0]?.at;
  const lastAt = fills.at(-1)?.at;
  const counts = fills.map((p) => p.message.sections.length);
  console.log(`progress messages      ${fills.length}  section counts [${counts.join(" ")}]`);
  console.log(`timeline               first section +${((firstAt - started) / 1000).toFixed(1)}s, ` +
    `last partial +${((lastAt - started) / 1000).toFixed(1)}s, done +${((finished - started) / 1000).toFixed(1)}s`);
  assert.ok(fills.length >= Math.min(3, sendable.length), "the pane must fill in steps, not once");
  assert.ok(counts.every((n, i) => i === 0 || n > counts[i - 1]), "section counts must only grow");
  assert.ok(lastAt - firstAt > 0.25 * (finished - firstAt) || fills.length === sendable.length,
    "partials must be spread over the stream, not bunched at the end");

  // 4. Reopen: a cache hit costs nothing.
  const cachedBefore = await used(providerId);
  const reopened = await runOutline(request, 1);
  assert.equal(reopened.cacheHit, true, `reopen was not a cache hit${result.warning ? ` (${result.warning})` : ""}`);
  assert.equal(fetches, 1, "a reopen must fetch nothing");
  assert.equal(await used(providerId), cachedBefore);
  console.log(`request count ${fetches}, quota +${delta}, reopen: cache hit, 0 requests  ✔`);
  fetches = 0;

  report(name, result, sendable);
  const m = measure(result, sendable);
  totals.papers++;
  totals.sections += m.filled.length;
  totals.bullets += m.bullets;
  totals.outside += m.outside;
  totals.long += m.long.length;
  m.thirds.forEach((n, i) => { totals.thirds[i] += n; totals.perThird[i] += m.bulletsPerThird[i]; });
  totals.numeric += m.numeric.length;
  totals.kept += m.keptNumbers.length;
  if (m.tldrSentences > 2) totals.tldrOver2++;
  totals.requests += result.usage.requests;
  totals.promptTokens += result.usage.promptTokens;
  totals.completionTokens += result.usage.completionTokens;
  totals.cost += detail.estCost ?? 0;
}

if (totals.papers > 1) {
  const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
  console.log(`\n===== totals over ${totals.papers} papers =====`);
  console.log(`requests ${totals.requests} (one per paper), tokens in ${totals.promptTokens}, out ${totals.completionTokens}, est. cost $${totals.cost.toFixed(3)}`);
  console.log(`sections ${totals.sections}, bullets ${totals.bullets}, sections outside 2-4: ${totals.outside}`);
  console.log(`bullets over 20 words ${totals.long} (${pct(totals.long, totals.bullets)}), by third: ` +
    totals.thirds.map((n, i) => `${n}/${totals.perThird[i]} (${pct(n, totals.perThird[i])})`).join(" · "));
  console.log(`results sections keeping numbers ${totals.kept}/${totals.numeric}; TL;DRs over 2 sentences: ${totals.tldrOver2}`);
}
