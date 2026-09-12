import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installIndexedDb } from "./idb.mjs";

// `plan` reads the consent store, so the database has to exist. Nothing is
// granted in this file: every assertion here is about the unconsented state.
installIndexedDb();

// The router reads storage.local for the API key; nothing else of the browser
// surface is touched by `plan`.
const store = { apiKeys: { gemini: "test-key-not-a-real-one" } };
globalThis.browser = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }) } },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
};
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error("the router must not send here"); };

const { plan, runOutline } = await import("../../src/background/router.js");
const { PROMPT_VERSION } = await import("../../src/model/prompts.js");

const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/bert.json", import.meta.url), "utf8"));
const hash = "a".repeat(64);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

await test("plan describes the send without making one", async () => {
  const detail = await plan({ hash, sections, meta: { title: "BERT", pageCount: 16 } });
  assert.equal(fetches, 0, "plan must issue no network request");
  assert.equal(detail.cacheKey, `${hash}:gemini-prod:gemini-3.8-flash:whole-document:${PROMPT_VERSION}`);
  assert.equal(detail.providerId, "gemini-prod");
  assert.equal(detail.destination, "google");
  assert.equal(detail.label, "Gemini 3.8 Flash");
  assert.equal(detail.requests, 1);
  assert.equal(detail.hasKey, true);
  assert.equal(detail.consented, false);
  assert.equal(detail.cacheHit, false);
  assert.equal(detail.sectionCount, sections.filter((s) => s.text.trim()).length);
  assert.deepEqual(detail.sectionTitles, sections.filter((s) => s.text.trim()).map((s) => s.title));
  assert.ok(detail.estTokens > 1000 && detail.estTokens < 100000);
  assert.ok(detail.estCost > 0 && detail.estCost < 0.5, `cost estimate ${detail.estCost}`);
  console.log(`      BERT: ${detail.sectionCount} sections, ~${detail.estTokens} tokens, est. $${detail.estCost.toFixed(4)}`);
});

await test("plan for a per-section provider counts N+1 requests and omits an unknown cost", async () => {
  const detail = await plan({ hash, sections, providerId: "gemini-dev" });
  assert.equal(detail.strategy, "per-section");
  assert.equal(detail.requests, detail.sectionCount + 1);
  assert.equal(detail.estCost, null, "no pricing on the descriptor means no cost line");
  assert.equal(fetches, 0);
});

await test("plan for the local provider says the text stays on the machine", async () => {
  const detail = await plan({ hash, sections, providerId: "ollama" });
  assert.equal(detail.destination, "local");
  assert.equal(detail.hasKey, false, "no keyRef, so no key is needed");
  assert.ok(detail.cacheKey.includes(":ollama:gemma4:e4b:per-section:"));
});

await test("the router refuses an unconsented outline and issues nothing", async () => {
  const answer = await runOutline({ hash, sections, meta: { title: "BERT" } }, 7);
  assert.equal(answer.error, "consent-required");
  assert.equal(answer.plan.cacheKey, `${hash}:gemini-prod:gemini-3.8-flash:whole-document:${PROMPT_VERSION}`);
  assert.equal(fetches, 0, "no document text may reach a provider without a grant");
});

await test("a different provider, model or prompt version is a different key", async () => {
  const a = (await plan({ hash, sections })).cacheKey;
  const b = (await plan({ hash, sections, providerId: "gemini-dev" })).cacheKey;
  const c = (await plan({ hash: "b".repeat(64), sections })).cacheKey;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a.split(":").at(-1), String(PROMPT_VERSION));
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
