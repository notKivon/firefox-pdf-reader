// One partition for everything that persists: the background's.
//
// A tab in a container (Zen workspaces use them) gets its own partition of
// IndexedDB, extension pages included. Found 2026-09-27 on the capture inbox,
// then on consent: the confirm card's grant was written into the reader tab's
// partition, the router's gate read its own, and the card came straight back
// after every click. So no page may reach an IndexedDB store at all — they ask
// the router — and that is checked here over the whole import graph rather than
// file by file, so a store pulled in through some other module is caught too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeNode } from "./dom.mjs";
import { installIndexedDb } from "./idb.mjs";
import { goodAnswer, installFetch } from "./stub.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
// The page entry points, as esbuild bundles them.
const ENTRIES = ["viewer/viewer.js", "settings/settings.js"];
// `storage.local` is one per extension, not per container, so these are safe.
const UNPARTITIONED = new Set(["store/apikeys.js", "store/settings.js"]);

const db = installIndexedDb();
const store = { apiKeys: { gemini: "test-key-not-a-real-one" } };
let routerListener;
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
globalThis.browser = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }) } },
  runtime: {
    onMessage: { addListener: (fn) => { routerListener = fn; } },
    // Every page message goes through the real router, as in Firefox.
    sendMessage: async (message) => routerListener(message, { tab: { id: 4 } }),
  },
  tabs: { sendMessage: async () => {} },
};

const { registerRouter } = await import("../../src/background/router.js");
registerRouter({ bypass: { grant: () => true } });
const { createOutlinePane } = await import("../../src/viewer/outline-pane.js");
const { ask } = await import("../../src/viewer/ask.js");
const { cacheKey } = await import("../../src/store/cache-key.js");

const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
const settle = () => new Promise((r) => setTimeout(r, 0));
const hashOf = (c) => c.repeat(64);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

// Static relative imports only; the pages have no dynamic ones.
function reachable(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(SRC, file), "utf8");
    for (const [, spec] of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gms)) {
      walk(relative(SRC, resolve(SRC, dirname(file), spec)));
    }
  };
  walk(entry);
  return seen;
}

await test("no page reaches an IndexedDB store, directly or through another module", async () => {
  for (const entry of ENTRIES) {
    const modules = reachable(entry);
    assert.ok(modules.size > 10, `${entry}: the walk found ${modules.size} modules — is the import regex broken?`);
    const stores = [...modules].filter((m) => m.startsWith("store/") && !UNPARTITIONED.has(m));
    assert.deepEqual(stores, [], `${entry} reaches ${stores.join(", ")}: a container tab would read and write its own partition`);
  }
  // The named cases, so a failure says which one came back.
  const viewer = reachable("viewer/viewer.js");
  for (const m of ["store/consent.js", "store/docs.js", "store/inbox.js", "store/db.js"]) assert.ok(!viewer.has(m), m);
});

await test("Generate outline grants through the router, and the router's gate then sends", async () => {
  const calls = installFetch((body) => goodAnswer(body));
  const hash = hashOf("1");
  const root = new FakeNode("div");
  createOutlinePane({ root }).start({ hash, meta: { title: "Adam", pageCount: 15 }, sections });
  for (let i = 0; i < 20 && !root.find("confirm-card"); i++) await settle();
  assert.ok(root.find("confirm-card"), "a fresh paper asks first");
  assert.equal(calls.length, 0);

  root.find("confirm-go").click();
  for (let i = 0; i < 50 && !root.find("outline-ready"); i++) await settle();
  assert.equal(root.find("confirm-card"), null, "the card did not come back — the bug this file exists for");
  assert.ok(root.find("outline-ready"), root.textContent);
  assert.equal(calls.length, 1, "whole-document: one request");
  const [grant] = db.records("consents").filter((r) => r.hash === hash);
  assert.equal(grant.key, cacheKey(hash, "gemini-prod"));
  assert.equal(grant.destination, "google", "taken from the descriptor");
});

await test("a grant is refused unless it names the key the router would derive", async () => {
  const hash = hashOf("2");
  const shown = cacheKey(hash, "gemini-prod");
  await assert.rejects(ask({ type: "grant", hash, providerId: "gemini-prod", cacheKey: shown.replace(/:\d+$/, ":0") }), /different send/);
  await assert.rejects(ask({ type: "grant", hash, providerId: "ollama", cacheKey: shown }), /different send/);
  await assert.rejects(ask({ type: "grant", hash: "not-a-hash", providerId: "gemini-prod", cacheKey: shown }), /hash/);
  assert.equal(db.records("consents").filter((r) => r.hash === hash).length, 0, "nothing was recorded");
});

await test("document records and reading positions live in the background", async () => {
  const hash = hashOf("3");
  const meta = { title: "Adam", pageCount: 15, authors: ["Kingma"] };
  const first = await ask({ type: "open-doc", hash, url: "https://arxiv.org/pdf/1412.6980", meta });
  assert.deepEqual(first.position, { page: 1, scrollTop: 0, scrollHeight: 0 });
  await ask({ type: "save-position", hash, position: { page: 4, scrollTop: 3100, scrollHeight: 12000 } });
  // Same bytes from another URL, and a page trying to overwrite identity.
  const again = await ask({ type: "open-doc", hash, url: "https://export.arxiv.org/pdf/1412.6980", meta: { ...meta, hash: "x", urls: [] } });
  assert.deepEqual(again.position, { page: 4, scrollTop: 3100, scrollHeight: 12000 });
  const records = db.records("docs").filter((r) => r.hash === hash);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].urls, ["https://export.arxiv.org/pdf/1412.6980", "https://arxiv.org/pdf/1412.6980"]);
  await assert.rejects(ask({ type: "save-position", hash, position: { page: "4" } }), /reading position/);
  // A picked local file has no URL, and none is recorded.
  await ask({ type: "open-doc", hash: hashOf("4"), meta });
  assert.deepEqual(db.records("docs").find((r) => r.hash === hashOf("4")).urls, []);
});

await test("settings lists and revokes grants through the router", async () => {
  const a = hashOf("5");
  const b = hashOf("6");
  await ask({ type: "open-doc", hash: a, url: "https://x.org/a.pdf", meta: { title: "Paper A", pageCount: 3 } });
  for (const [hash, providerId] of [[a, "gemini-prod"], [a, "gemini-dev"], [b, "ollama"]]) {
    await ask({ type: "grant", hash, providerId, cacheKey: cacheKey(hash, providerId) });
  }
  const { consents, docs } = await ask({ type: "consents" });
  assert.equal(consents.filter((c) => c.hash === a || c.hash === b).length, 3);
  assert.equal(docs[a].title, "Paper A");
  assert.equal(docs[b], null, "no record costs the title, not the list");

  await assert.rejects(ask({ type: "revoke" }), /hash/, "all is never implied by a missing hash");
  assert.deepEqual(await ask({ type: "revoke", hash: a }), { count: 2 });
  const { count } = await ask({ type: "revoke", all: true });
  assert.ok(count >= 1);
  assert.equal(db.records("consents").length, 0);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
