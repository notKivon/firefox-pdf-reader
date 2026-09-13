// Getting into settings from a paper, and back out to that same paper.
import assert from "node:assert/strict";

const { goBack, openSettingsFrom, returnTabId } = await import("../../src/settings/back.js");

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

const BASE = "moz-extension://id/settings.html";

function fakeTabs(open, currentId) {
  const log = [];
  return {
    log,
    getCurrent: async () => open.find((t) => t.id === currentId),
    query: async () => open,
    update: async (id, props) => {
      if (!open.some((t) => t.id === id)) throw new Error(`Invalid tab ID: ${id}`);
      log.push(["update", id, props]);
    },
    remove: async (id) => log.push(["remove", id]),
    create: async (props) => log.push(["create", props]),
  };
}
const history = (length) => ({ length, back() { this.went = true; } });

await test("only a real tab id is read from ?from=", () => {
  assert.equal(returnTabId("?from=12"), 12);
  for (const bad of ["", "?from=", "?from=-1", "?from=1.5", "?from=abc"]) assert.equal(returnTabId(bad), null, bad);
});

await test("Back switches to the paper that opened settings, then closes settings", async () => {
  const tabs = fakeTabs([{ id: 4 }, { id: 9 }], 9);
  const h = history(1);
  assert.equal(await goBack({ tabs, search: "?from=4", history: h }), "reader");
  assert.deepEqual(tabs.log, [["update", 4, { active: true }], ["remove", 9]]);
  assert.equal(h.went, undefined);
});

await test("if that paper's tab is gone, Back uses history, else closes the tab", async () => {
  const tabs = fakeTabs([{ id: 9 }], 9);
  const h = history(3);
  assert.equal(await goBack({ tabs, search: "?from=4", history: h }), "history");
  assert.equal(h.went, true);
  assert.deepEqual(tabs.log, [], "a failed switch must not close settings");

  const lone = fakeTabs([{ id: 9 }], 9);
  assert.equal(await goBack({ tabs: lone, search: "", history: history(1) }), "closed");
  assert.deepEqual(lone.log, [["remove", 9]]);
});

await test("opening settings carries the reader's tab id and reuses an open settings tab", async () => {
  const runtime = { getURL: (p) => `moz-extension://id/${p}` };
  const fresh = fakeTabs([{ id: 4, url: "moz-extension://id/viewer.html" }], 4);
  await openSettingsFrom({ tabs: fresh, runtime });
  assert.deepEqual(fresh.log, [["create", { url: `${BASE}?from=4`, openerTabId: 4 }]]);

  const reuse = fakeTabs([{ id: 4, url: "moz-extension://id/viewer.html" }, { id: 7, url: `${BASE}?from=2` }], 4);
  await openSettingsFrom({ tabs: reuse, runtime });
  assert.deepEqual(reuse.log, [["update", 7, { url: `${BASE}?from=4`, active: true }]]);
});

console.log(results.join("\n"));
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
