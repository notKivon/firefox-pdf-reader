import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installIndexedDb } from "./idb.mjs";
import { goodAnswer, installFetch, rateLimited } from "./stub.mjs";

// Step 10's two rules, together because they meet in the router: a cache hit
// makes zero network requests and asks no confirmation, and a provider out of
// requests falls through to the next one of the same destination — never to the
// local model.
const db = installIndexedDb();

const store = { apiKeys: { gemini: "test-key-not-a-real-one" } };
globalThis.browser = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }) } },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
};

const { plan, runOutline } = await import("../../src/background/router.js");
const { grantConsent } = await import("../../src/store/consent.js");
const { cacheKey } = await import("../../src/store/cache-key.js");
const { hasRoomFor, record, used } = await import("../../src/store/quota.js");
const { getProvider } = await import("../../src/model/providers.js");

const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
const meta = { title: "Adam", pageCount: 15 };
const hashes = (n) => String(n).repeat(64).slice(0, 64);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

// Consent is step 8's gate; every test here is about what happens after it.
async function consent(hash, providerId) {
  await grantConsent({
    cacheKey: cacheKey(hash, providerId),
    hash,
    providerId,
    model: getProvider(providerId).model,
    destination: getProvider(providerId).destination,
  });
}

// Fills the day's counter to the brim for one provider, whatever it stands at.
async function exhaust(providerId) {
  const { rpd } = getProvider(providerId).limits;
  await record(providerId, rpd - (await used(providerId)));
  assert.equal(await hasRoomFor(providerId, 1), false, `${providerId} should be exhausted`);
}

// ------------------------------------------------------------------- caching
const cachedHash = hashes(1);

await test("a verified outline is cached under the key of the provider that served it", async () => {
  await consent(cachedHash, "gemini-prod");
  const calls = installFetch((body) => goodAnswer(body));
  const result = await runOutline({ hash: cachedHash, sections, meta });

  assert.equal(result.error, undefined, result.message);
  assert.equal(calls.length, 1, "whole-document is one request");
  assert.equal(result.warning, undefined, "a complete outline caches without complaint");
  const row = db.records("outlines").find((r) => r.hash === cachedHash);
  assert.ok(row, "the outline was not written");
  assert.equal(row.key, cacheKey(cachedHash, "gemini-prod"));
  assert.equal(row.model, "gemini-3.8-flash");
  assert.equal(row.sections.length, sections.length);
  assert.ok(row.sections.every((s) => typeof s.page === "number"), "jump targets travel with the cache entry");
  assert.ok(row.tldr.length > 0);
  assert.ok(row.createdAt > 0);
});

await test("reopening it makes zero network requests and asks nothing", async () => {
  const calls = installFetch(() => {
    throw new Error("a cache hit must not reach a provider");
  });
  const before = await used("gemini-prod");

  const detail = await plan({ hash: cachedHash, sections, meta });
  assert.equal(detail.cacheHit, true);
  assert.equal(detail.outline.sections.length, sections.length, "the pane renders this, not a card");

  const result = await runOutline({ hash: cachedHash, sections, meta });
  assert.equal(result.cacheHit, true);
  assert.equal(result.sections.length, sections.length);
  assert.equal(calls.length, 0, "zero requests");
  assert.equal(await used("gemini-prod"), before, "and zero against the quota");
});

await test("a cache hit needs no consent, because nothing is being sent", async () => {
  const { revokeDocument } = await import("../../src/store/consent.js");
  await revokeDocument(cachedHash);
  installFetch(() => {
    throw new Error("a cache hit must not reach a provider");
  });
  const result = await runOutline({ hash: cachedHash, sections, meta });
  assert.equal(result.cacheHit, true, "the card is for sends, and this is not one");
  await consent(cachedHash, "gemini-prod"); // put it back for later tests
});

await test("another provider, model, strategy or prompt version is a different key", async () => {
  installFetch(() => {
    throw new Error("plan must never send");
  });
  const detail = await plan({ hash: cachedHash, sections, meta, providerId: "gemini-dev" });
  assert.equal(detail.cacheHit, false, "a gemini-prod outline is not a gemini-dev one");
  assert.equal(detail.consented, false, "and it asks again, because it is a different thing being sent");
  const other = await plan({ hash: hashes(2), sections, meta });
  assert.equal(other.cacheHit, false, "a different document is a different key");
});

await test("a partial outline is never cached, so the gaps are not permanent", async () => {
  const hash = hashes(3);
  await consent(hash, "gemini-dev");
  installFetch((body, i) => {
    if (!body.response_format.json_schema.schema.properties.sections) return { tldr: "t" };
    return i === 2 ? "not json at all" : goodAnswer(body);
  });
  const result = await runOutline({ hash, sections, meta, providerId: "gemini-dev" });

  assert.equal(result.sections.filter((s) => s.error).length, 1);
  assert.match(result.warning, /not cached/, "the reader is told, rather than left to wonder");
  assert.equal(db.records("outlines").filter((r) => r.hash === hash).length, 0);
  assert.equal((await plan({ hash, sections, meta, providerId: "gemini-dev" })).cacheHit, false);
});

// ------------------------------------------------------ quota and fallback
await test("every dispatched request is counted, a refused one included", async () => {
  const hash = hashes(4);
  await consent(hash, "gemini-prod");
  const before = await used("gemini-prod");
  const devBefore = await used("gemini-dev");
  installFetch((body) => (body.model === "gemini-3.8-flash" ? rateLimited() : goodAnswer(body)));

  const result = await runOutline({ hash, sections, meta });
  assert.equal(result.providerId, "gemini-dev");
  assert.equal(await used("gemini-prod"), before + 1, "the 429 was a request the provider answered");
  const sendable = sections.filter((s) => s.text.trim()).length;
  assert.equal(await used("gemini-dev"), devBefore + sendable + 1, "per-section is N + 1");
});

await test("an exhausted daily quota falls through without dispatching a request", async () => {
  const hash = hashes(5);
  await consent(hash, "gemini-prod");
  await exhaust("gemini-prod");
  const calls = installFetch((body) => {
    assert.notEqual(body.model, "gemini-3.8-flash", "a run that cannot fit must not start");
    return goodAnswer(body);
  });

  const result = await runOutline({ hash, sections, meta });
  assert.equal(result.providerId, "gemini-dev", "the same destination, so the consent given still covers it");
  assert.ok(calls.every((c) => !c.url.includes("127.0.0.1")), "never the local model");
  assert.equal(db.records("outlines").find((r) => r.hash === hash).key, cacheKey(hash, "gemini-dev"));
});

await test("both exhausted stops, names the reset in Hong Kong time, and offers the local model", async () => {
  const hash = hashes(6);
  await consent(hash, "gemini-prod");
  await exhaust("gemini-prod");
  await exhaust("gemini-dev");
  const calls = installFetch(() => {
    throw new Error("nothing may be dispatched once the chain is exhausted");
  });

  // What the pane receives: `registerRouter` converts a thrown ProviderError,
  // because an Error does not survive the structured clone.
  const result = await runOutline({ hash, sections, meta }).catch((err) => err.toJSON());
  assert.equal(result.error, "exhausted");
  assert.match(result.message, /Gemini 3\.5 Flash-Lite/, "which provider is exhausted");
  assert.match(result.message, /Hong Kong time/, "and when it comes back, where the reader lives");
  assert.deepEqual(result.otherDestinations, ["ollama"], "offered as a choice, never taken");
  assert.equal(calls.length, 0);
  assert.equal(db.records("outlines").filter((r) => r.hash === hash).length, 0);
});

await test("the next quota day clears the exhaustion", async () => {
  const hash = hashes(7);
  await consent(hash, "gemini-prod");
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 3600 * 1000; // a stubbed date change
  try {
    const calls = installFetch((body) => goodAnswer(body));
    const result = await runOutline({ hash, sections, meta });
    assert.equal(result.providerId, "gemini-prod", "tomorrow the first provider serves again");
    assert.equal(calls.length, 1);
    assert.equal(await used("gemini-prod"), 1, "counted against the new day, not added to yesterday");
  } finally {
    Date.now = realNow;
  }
  assert.equal(await hasRoomFor("gemini-prod", 1), false, "yesterday is still exhausted");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
