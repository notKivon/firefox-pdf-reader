// Step 14: settings, the escape hatch, local files, and the stall watchdog.
// What is pinned is what could be wrong without anything on screen saying so:
// a stored order that moves the local model into an automatic path, an opt-out
// entry that never matches, a bypass that outlives its one use, a key shown
// back in the page, a hung provider leaving the pane spinning.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installIndexedDb } from "./idb.mjs";
import { FakeNode } from "./dom.mjs";

installIndexedDb();
const store = {};
const storageListeners = [];
globalThis.browser = {
  storage: {
    local: {
      get: async (k) => ({ [k]: structuredClone(store[k]) }),
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: structuredClone(v) }; store[k] = structuredClone(v); }
        for (const fn of storageListeners) fn(changes, "local");
      },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
  runtime: { onMessage: { addListener() {} }, getURL: (p) => `moz-extension://id/${p}` },
  tabs: { sendMessage: async () => {} },
};

const { normalizeOrder, normalizeHosts, DEFAULT_ORDER, setProviderOrder } = await import("../../src/store/settings.js");
const { fallbacksFor } = await import("../../src/model/providers.js");
const { createBypass, BYPASS_TTL_MS } = await import("../../src/background/bypass.js");
const { createWatchdog } = await import("../../src/background/watchdog.js");
const { plan, runOutline } = await import("../../src/background/router.js");
const { registerInterceptor } = await import("../../src/background/intercept.js");
const { grantConsent } = await import("../../src/store/consent.js");
const { fromFile, requestedUrl, isWebUrl, MAX_LOCAL_BYTES } = await import("../../src/viewer/source.js");
const { leaveForNativeViewer } = await import("../../src/viewer/actions.js");
const { groupGrants, maskKey, moveItem, formatWhen } = await import("../../src/settings/model.js");
const { renderKeys } = await import("../../src/settings/keys-section.js");
const { renderHosts } = await import("../../src/settings/hosts-section.js");

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

await test("a stored order is normalised: unknown ids dropped, duplicates collapsed, missing ones appended", () => {
  assert.deepEqual(normalizeOrder("garbage"), DEFAULT_ORDER);
  assert.deepEqual(normalizeOrder(["ollama", "nope", "ollama"]), ["ollama", ...DEFAULT_ORDER.filter((id) => id !== "ollama")]);
});

await test("no order can put the local model in a Google provider's fallback chain", () => {
  for (const order of [["ollama", "gemini-dev", "gemini-prod"], ["gemini-prod", "ollama", "gemini-dev"]]) {
    assert.deepEqual(fallbacksFor("gemini-prod", order), order.indexOf("gemini-dev") > order.indexOf("gemini-prod") ? ["gemini-dev"] : []);
    assert.ok(!fallbacksFor("gemini-dev", order).includes("ollama"));
  }
  assert.deepEqual(fallbacksFor("ollama", ["ollama", "gemini-prod", "gemini-dev"]), []);
});

await test("plan with no provider named uses the first of the reader's order", async () => {
  await setProviderOrder(["gemini-dev", "gemini-prod", "ollama"]);
  const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
  const detail = await plan({ hash: "c".repeat(64), sections });
  assert.equal(detail.providerId, "gemini-dev");
  assert.deepEqual(detail.otherProviders.map((p) => p.id), ["gemini-prod", "ollama"]);
  await setProviderOrder(DEFAULT_ORDER);
});

await test("opt-out hosts accept pasted URLs and reject what is not a host", () => {
  const { hosts, rejected } = normalizeHosts("https://Www.Example.org/path?x=1\nexample.org:8080, localhost\nfoo\nwww.example.org");
  assert.deepEqual(hosts, ["www.example.org", "example.org", "localhost"]);
  assert.deepEqual(rejected, ["foo"]);
});

await test("the interceptor honours an opt-out saved in any case, and spends a bypass exactly once", async () => {
  let listener;
  browser.webRequest = { onHeadersReceived: { addListener: (fn) => { listener = fn; } } };
  const bypass = createBypass();
  registerInterceptor({ bypass });
  await tick();
  const pdf = (url, tabId = 7) => listener({ url, tabId, type: "main_frame", statusCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/pdf" }] });

  await browser.storage.local.set({ optOutHosts: ["Journals.Example.ORG"] });
  assert.deepEqual(pdf("https://journals.example.org/a"), {});
  assert.ok(pdf("https://arxiv.org/pdf/1").redirectUrl);

  assert.equal(bypass.grant(7), true);
  assert.deepEqual(pdf("https://arxiv.org/pdf/1"), {}, "the pass lets one PDF through");
  assert.ok(pdf("https://arxiv.org/pdf/1").redirectUrl, "and only one");
  assert.equal(bypass.grant(undefined), false, "a message from no tab gets no pass");
});

await test("an unused bypass expires", () => {
  let now = 1000;
  const bypass = createBypass(() => now);
  bypass.grant(3);
  now += BYPASS_TTL_MS + 1;
  assert.equal(bypass.consume(3), false);
});

await test("leaving for the native viewer navigates only after the background agrees", async () => {
  const went = [];
  browser.runtime.sendMessage = async () => ({ ok: true });
  await leaveForNativeViewer("https://arxiv.org/pdf/1", { navigate: (u) => went.push(u) });
  assert.deepEqual(went, ["https://arxiv.org/pdf/1"]);
  browser.runtime.sendMessage = async () => ({ error: "internal", message: "no" });
  await assert.rejects(leaveForNativeViewer("https://x.org/a", { navigate: (u) => went.push(u) }), /no/);
  assert.equal(went.length, 1, "a refusal must not navigate back into the interceptor");
});

await test("the watchdog fires on silence, and a sign of life re-arms it", async () => {
  const timers = [];
  const dog = createWatchdog({ ms: 50, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  dog.poke();
  assert.equal(dog.fired, false);
  timers.at(-1)();
  assert.equal(dog.fired, true);
  assert.equal(dog.signal.aborted, true);
});

await test("a provider that accepts and never answers ends in a readable stall error, not a spinner", async () => {
  const hash = "d".repeat(64);
  const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
  const detail = await plan({ hash, sections, providerId: "gemini-prod" });
  await grantConsent({ cacheKey: detail.cacheKey, hash, providerId: "gemini-prod", model: detail.model, destination: "google" });
  store.apiKeys = { gemini: "test-key-not-a-real-one" };
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const watchdog = createWatchdog({ ms: 30 });
  await assert.rejects(runOutline({ hash, sections, providerId: "gemini-prod" }, undefined, { watchdog }), (err) => {
    assert.equal(err.kind, "stalled");
    assert.match(err.message, /stopped responding.*nothing was cached/);
    return true;
  });
});

await test("a local file over the size cap, or none at all, fails in words", async () => {
  await assert.rejects(fromFile(null), /No file was chosen/);
  await assert.rejects(fromFile({ name: "huge.pdf", size: MAX_LOCAL_BYTES + 1 }), /too large/);
  const picked = await fromFile({ name: "p.pdf", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  assert.equal(picked.local, true);
  assert.equal(picked.url, "local:p.pdf");
  assert.equal(requestedUrl("?file="), null);
  assert.equal(isWebUrl("file:///x.pdf"), false);
});

await test("grants group per document, newest first, dated in Hong Kong time", () => {
  const docs = new Map([["h1", { title: "Adam" }]]);
  const groups = groupGrants([
    { key: "k1", hash: "h1", providerId: "gemini-prod", model: "gemini-3.8-flash", destination: "google", grantedAt: Date.UTC(2026, 8, 13, 0, 0) },
    { key: "k2", hash: "h2".padEnd(64, "0"), providerId: "ollama", model: "gemma4:e4b", destination: "local", grantedAt: Date.UTC(2026, 8, 13, 1, 0) },
  ], docs);
  assert.deepEqual(groups.map((g) => g.title), [`Document ${"h2".padEnd(12, "0")}…`, "Adam"]);
  assert.equal(formatWhen(Date.UTC(2026, 8, 13, 0, 0)), "13 Sept 2026, 08:00 HKT");
  assert.equal(moveItem(["a", "b"], 0, -1).join(), "a,b");
  assert.equal(moveItem(["a", "b"], 0, 1).join(), "b,a");
});

await test("the key field never shows the stored key, only its last four characters", async () => {
  store.apiKeys = { gemini: "AIzaTESTTESTTESTwxyz" };
  const body = new FakeNode("div");
  await renderKeys(body);
  const input = body.children[0].children[2].children[0];
  assert.equal(input.value ?? "", "");
  assert.ok(!JSON.stringify(body.textContent).includes("AIzaTEST"));
  assert.match(body.textContent, /…wxyz/);
  assert.equal(maskKey("short"), "…");

  input.value = "  AIzaNEWKEYNEWKEY1234 ";
  body.children[0].children[2].children[1].click();
  await tick(); await tick();
  assert.equal(store.apiKeys.gemini, "AIzaNEWKEYNEWKEY1234");
  assert.equal(input.value, "", "the field is emptied once saved");
  assert.match(body.textContent, /…1234/);
});

await test("an unreadable opt-out line saves nothing and says which line", async () => {
  await browser.storage.local.set({ optOutHosts: ["kept.org"] });
  const body = new FakeNode("div");
  await renderHosts(body);
  const [area, row, status] = body.children;
  area.value = "good.org\nnot a host";
  row.children[0].click();
  await tick(); await tick();
  assert.deepEqual(store.optOutHosts, ["kept.org"]);
  assert.match(status.textContent, /Not saved.*not a host/);
});

console.log(results.join("\n"));
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
