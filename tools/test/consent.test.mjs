// The send-confirmation gate (CLAUDE.md): nothing reaches a model unasked, the
// grant is per cache key, and the check is the router's own — not the viewer's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installIndexedDb } from "./idb.mjs";
import { goodAnswer, installFetch } from "./stub.mjs";

const idb = installIndexedDb();
globalThis.browser = {
  storage: { local: { get: async () => ({ apiKeys: { gemini: "test-key-not-a-real-one" } }) } },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
};

const { grantConsent, isConsented, consentsFor, revokeConsent, revokeDocument } =
  await import("../../src/store/consent.js");
const { plan, runOutline } = await import("../../src/background/router.js");
const { CONSENTS } = await import("../../src/store/db.js");

const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
const hash = "c".repeat(64);
const meta = { title: "Adam", pageCount: 15 };

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

await test("an absent grant reads as ask, never as consent", async () => {
  assert.equal(await isConsented("nothing:was:ever:granted:1"), false);
  assert.equal(idb.version(), 2, "the consents store arrives with database version 2");
  assert.equal(await isConsented(undefined), false);
});

await test("a grant is remembered, scoped to its key, and revocable", async () => {
  const detail = await plan({ hash, sections, meta, providerId: "gemini-dev" });
  await grantConsent(detail);
  assert.equal(await isConsented(detail.cacheKey), true);
  const [record] = idb.records(CONSENTS);
  assert.equal(record.destination, "google");
  assert.equal(record.model, "gemini-3.5-flash-lite");
  assert.ok(record.grantedAt > 1_700_000_000_000, "grantedAt is epoch milliseconds");
  // Same paper, different provider: a different thing being sent somewhere.
  assert.equal(await isConsented((await plan({ hash, sections, meta })).cacheKey), false);
  await revokeConsent(detail.cacheKey);
  assert.equal(await isConsented(detail.cacheKey), false);
});

await test("every grant for one document is findable and revocable together", async () => {
  for (const providerId of ["gemini-prod", "gemini-dev", "ollama"]) {
    await grantConsent(await plan({ hash, sections, meta, providerId }));
  }
  await grantConsent(await plan({ hash: "d".repeat(64), sections, meta }));
  assert.equal((await consentsFor(hash)).length, 3);
  assert.equal(await revokeDocument(hash), 3);
  assert.equal((await consentsFor(hash)).length, 0);
  assert.equal((await consentsFor("d".repeat(64))).length, 1, "another document's grants are untouched");
});

await test("the router refuses an unconsented outline and sends nothing", async () => {
  const calls = installFetch(goodAnswer);
  const answer = await runOutline({ hash, sections, meta });
  assert.equal(answer.error, "consent-required");
  assert.equal(calls.length, 0, "no document text may reach a provider without a grant");
  assert.equal(answer.plan.consented, false);
});

await test("a viewer claiming consent cannot cause a send", async () => {
  const calls = installFetch(goodAnswer);
  // Everything the viewer could forge: the flag, the plan, the whole message.
  const answer = await runOutline({ hash, sections, meta, consented: true, plan: { consented: true } });
  assert.equal(answer.error, "consent-required");
  assert.equal(calls.length, 0, "the gate is the router's own read, not the viewer's word");
});

await test("a grant for another provider does not unlock this one", async () => {
  await grantConsent(await plan({ hash, sections, meta, providerId: "gemini-dev" }));
  const calls = installFetch(goodAnswer);
  const answer = await runOutline({ hash, sections, meta, providerId: "gemini-prod" });
  assert.equal(answer.error, "consent-required");
  assert.equal(calls.length, 0);
  await revokeDocument(hash);
});

await test("after the grant, and only then, the outline is produced", async () => {
  const detail = await plan({ hash, sections, meta });
  assert.equal(detail.consented, false);
  await grantConsent(detail);
  assert.equal((await plan({ hash, sections, meta })).consented, true, "plan reports the grant back");

  const calls = installFetch(goodAnswer);
  const result = await runOutline({ hash, sections, meta });
  assert.equal(result.error, undefined, result.message);
  assert.equal(calls.length, 1, "whole-document: one request for the paper");
  assert.equal(result.sections.length, sections.length);
  await revokeDocument(hash);
});

await test("the local provider has no loopback exemption", async () => {
  const detail = await plan({ hash, sections, meta, providerId: "ollama" });
  assert.equal(detail.destination, "local");
  const calls = installFetch(goodAnswer);
  assert.equal((await runOutline({ hash, sections, meta, providerId: "ollama" })).error, "consent-required");
  assert.equal(calls.length, 0, "nothing reaches 127.0.0.1 unasked either");
  await grantConsent(detail);
  assert.equal((await runOutline({ hash, sections, meta, providerId: "ollama" })).error, undefined);
  assert.ok(calls.length > 0);
  await revokeDocument(hash);
});

await test("the plan the card renders carries everything CLAUDE.md requires it to state", async () => {
  const detail = await plan({ hash, sections, meta });
  for (const field of ["title", "pageCount", "sectionCount", "estTokens", "label", "model", "destination"]) {
    assert.ok(detail[field] !== undefined && detail[field] !== "", `plan.${field} is missing`);
  }
  assert.equal(detail.host, "generativelanguage.googleapis.com");
  assert.deepEqual(detail.alternatives, [{ id: "ollama", label: "Gemma 4 E4B (local)", destination: "local" }]);
  const local = await plan({ hash, sections, meta, providerId: "ollama" });
  assert.equal(local.host, "127.0.0.1:11434");
  assert.deepEqual(local.alternatives.map((a) => a.id), ["gemini-prod", "gemini-dev"]);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
