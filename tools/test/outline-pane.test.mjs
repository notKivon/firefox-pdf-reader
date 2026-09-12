// The pane's states around the send, and one rule that is easy to lose: every
// state the reader can be stranded in has to offer the other destination.
//
// The card carries that control, but the card is shown once per cache key — once
// consent is granted it never returns, so an error after the grant is exactly
// where a reader gets stuck on the provider that just failed.
import assert from "node:assert/strict";
import { FakeNode } from "./dom.mjs";

globalThis.document = { createElement: (tag) => new FakeNode(tag) };

const PLAN = {
  cacheKey: "abc:gemini-prod:gemini-3.8-flash:whole-document:1",
  hash: "abc", title: "Adam", pageCount: 15, sectionCount: 10, sectionTitles: ["1 Introduction"],
  estTokens: 5000, requests: 1, label: "Gemini 3.8 Flash", model: "gemini-3.8-flash",
  destination: "google", host: "generativelanguage.googleapis.com", estCost: 0.01,
  hasKey: false, consented: false, cacheHit: false,
  alternatives: [{ id: "ollama", label: "Gemma 4 E4B (local)", destination: "local" }],
};

const LOCAL_PLAN = {
  ...PLAN,
  cacheKey: "abc:ollama:gemma4:e4b:per-section:1", providerId: "ollama",
  label: "Gemma 4 E4B (local)", model: "gemma4:e4b", destination: "local",
  host: "127.0.0.1:11434", estCost: null, hasKey: false, requests: 2,
  alternatives: [{ id: "gemini-prod", label: "Gemini 3.8 Flash", destination: "google" }],
};

// Every message the pane sends, and whatever the test wants sent back.
function stubBrowser(reply) {
  const sent = [];
  globalThis.browser = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        sent.push(message);
        return reply(message, sent.length - 1);
      },
    },
  };
  return sent;
}

const { createOutlinePane } = await import("../../src/viewer/outline-pane.js");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const DOC = { hash: "abc", meta: { title: "Adam", pageCount: 15 }, sections: [{ title: "1 Introduction", text: "x".repeat(500) }] };

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

await test("a fresh document plans, shows the card, and sends nothing", async () => {
  const sent = stubBrowser(() => PLAN);
  const root = new FakeNode("div");
  createOutlinePane({ root }).start(DOC);
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ["plan"], "only the plan message, which sends nothing");
  assert.ok(root.find("confirm-card"), "the card is the pane's first state");
});

await test("a failure after the grant still offers the other destination", async () => {
  const sent = stubBrowser((message) => {
    if (message.type !== "plan") return { error: "auth", message: "No API key is stored for Gemini 3.8 Flash." };
    // Consent is per cache key, so the grant on record covers only the provider
    // it was given for — switching destination has to ask again.
    return message.providerId === "ollama"
      ? { ...LOCAL_PLAN, consented: false }
      : { ...PLAN, providerId: "gemini-prod", consented: true };
  });
  const root = new FakeNode("div");
  createOutlinePane({ root }).start(DOC);
  await settle();

  // Consent was already on record, so no card: straight to the send, which fails.
  assert.equal(root.find("confirm-card"), null);
  assert.ok(root.find("pane-error").textContent.includes("No API key"), "the failure is in words");
  const alternatives = root.findAll("confirm-alt-go");
  assert.equal(alternatives.length, 1, "the error state must not strand the reader on one provider");
  assert.equal(alternatives[0].textContent, "Gemma 4 E4B (local)");

  // Choosing it re-plans and asks again. It never sends.
  alternatives[0].click();
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ["plan", "outline", "plan"]);
  assert.equal(sent.at(-1).providerId, "ollama");
  assert.ok(root.find("confirm-card"), "the new destination asks for its own confirmation");
  assert.ok(root.textContent.includes("Stays on this machine"), root.textContent);
});

await test("a scanned PDF shows no card and sends nothing at all", async () => {
  const sent = stubBrowser(() => PLAN);
  const root = new FakeNode("div");
  createOutlinePane({ root }).start({ ...DOC, scanned: true });
  await settle();
  assert.deepEqual(sent, [], "not even a plan: there is nothing to outline");
  assert.equal(root.find("confirm-card"), null);
  assert.ok(root.textContent.includes("scanned PDF"), root.textContent);
});

await test("a document with no section text shows no card either", async () => {
  const sent = stubBrowser(() => PLAN);
  const root = new FakeNode("div");
  createOutlinePane({ root }).start({ ...DOC, sections: [{ title: "Results", text: "   " }] });
  await settle();
  assert.deepEqual(sent, []);
  assert.equal(root.find("confirm-card"), null);
});

await test("the router's refusal renders the card rather than an error", async () => {
  stubBrowser((message) =>
    message.type === "plan" ? { ...PLAN, consented: true } : { error: "consent-required", plan: PLAN },
  );
  const root = new FakeNode("div");
  createOutlinePane({ root }).start(DOC);
  await settle();
  assert.ok(root.find("confirm-card"), "a viewer out of step with the store must land back on the card");
  assert.equal(root.find("pane-error"), null);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
