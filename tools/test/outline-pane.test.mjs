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
  otherProviders: [
    { id: "gemini-dev", label: "Gemini 3.5 Flash-Lite (development)", destination: "google" },
    { id: "ollama", label: "Gemma 4 E4B (local)", destination: "local" },
  ],
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

await test("a finished outline renders, jumps, and hands its targets to the spy", async () => {
  const outline = {
    model: "gemini-3.8-flash",
    tldr: "Adam adapts a learning rate per parameter.",
    sections: [{ title: "1 Introduction", page: 1, y: 700, bullets: ["Stochastic optimisation is central."] }],
  };
  stubBrowser((message) => (message.type === "plan" ? { ...PLAN, consented: true } : outline));

  const jumps = [];
  let handed = null;
  const root = new FakeNode("div");
  const pane = createOutlinePane({
    root,
    onJump: (target) => jumps.push(target),
    onSections: (targets) => (handed = targets),
  });
  pane.start(DOC);
  await settle();

  assert.ok(root.find("outline-tldr-text"), "the TL;DR is rendered, not counted");
  root.find("outline-bullet-go").click();
  assert.deepEqual(jumps, [{ page: 1, y: 700 }], "the bullet jumps to its section");
  assert.deepEqual(handed, [{ page: 1, y: 700 }], "the spy gets the same targets");

  // The spy only ever speaks to the pane, so this is the path that highlights.
  pane.setActive(0);
  assert.ok(root.find("outline-section").classList.contains("is-current"));
});

await test("onReady fires for a finished or cached outline, never for the card, an error or a partial fill", async () => {
  const outline = { model: "gemini-3.8-flash", tldr: "T.", sections: [{ title: "1 Introduction", page: 1, y: 700, bullets: ["B."] }] };
  const run = async (reply, after) => {
    stubBrowser(reply);
    let ready = 0;
    const pane = createOutlinePane({ root: new FakeNode("div"), onReady: () => ready++ });
    pane.start(DOC);
    await settle();
    after?.(pane);
    return ready;
  };
  assert.equal(await run((m) => (m.type === "plan" ? { ...PLAN, consented: true } : outline)), 1, "fresh outline");
  assert.equal(await run(() => ({ ...PLAN, cacheHit: true, outline })), 1, "cache hit");
  assert.equal(await run(() => PLAN), 0, "the confirm card");
  assert.equal(await run((m) => (m.type === "plan" ? { ...PLAN, consented: true } : { error: "auth", message: "x" })), 0, "an error");
  const partial = (pane) => pane.progress({ hash: "abc", sections: outline.sections });
  assert.equal(await run((m) => (m.type === "plan" ? { ...PLAN, consented: true } : new Promise(() => {})), partial), 0, "a partial fill");
});

await test("leaving the outline for another state tells the spy there is nothing to track", async () => {
  stubBrowser((message) =>
    message.type === "plan" ? { ...PLAN, consented: true } : { error: "auth", message: "No API key is stored." },
  );
  const handed = [];
  const root = new FakeNode("div");
  createOutlinePane({ root, onSections: (targets) => handed.push(targets) }).start(DOC);
  await settle();
  // A stale target list would scroll-spy against sections that are no longer on
  // screen; every state change has to clear it.
  assert.deepEqual(handed.at(-1), []);
});

await test("progressive fill renders the sections that have landed, already clickable", async () => {
  stubBrowser((message) => (message.type === "plan" ? { ...PLAN, consented: true } : new Promise(() => {})));
  const jumps = [];
  const root = new FakeNode("div");
  const pane = createOutlinePane({ root, onJump: (target) => jumps.push(target) });
  pane.start(DOC);
  await settle();

  pane.progress({ hash: "abc", sections: [{ title: "1 Introduction", page: 1, y: 700, bullets: ["Present."] }] });
  assert.ok(root.textContent.includes("Gemini 3.8 Flash"), "the progress line still says who is writing it");
  root.find("outline-bullet-go").click();
  assert.deepEqual(jumps, [{ page: 1, y: 700 }]);

  // A fallback notice carries no sections and must not blank what is rendered.
  pane.progress({ hash: "abc", providerId: "gemini-dev" });
  assert.ok(root.find("outline-bullet-go"), "the sections already on screen stay");
  // Nor may a message about a different document.
  pane.progress({ hash: "other", sections: [{ title: "X", page: 9, y: 1, bullets: ["Wrong paper."] }] });
  assert.equal(root.findAll("outline-bullet-go").length, 1);
});

// ---- asked for 2026-09-13: change model without starting the paper over
await test("a finished outline offers every other model, and picking one re-plans", async () => {
  const sent = stubBrowser((message) =>
    message.type === "plan"
      ? { ...PLAN, providerId: message.providerId ?? "gemini-prod", consented: true }
      : { sections: [], tldr: "t", model: "gemini-3.8-flash" });
  const root = new FakeNode("div");
  const pane = createOutlinePane({ root, onJump() {}, onSections() {} });
  pane.start({ hash: "abc", meta: {}, sections: [{ title: "1 Intro", page: 1, y: 700, text: "words here" }] });
  await settle();

  const options = root.findAll("outline-switch-go");
  assert.equal(options.length, 2, "both other models, same destination included");
  assert.ok(options.some((o) => o.textContent.includes("Gemma 4 E4B")), "the local one among them");
  assert.ok(options.some((o) => o.textContent.includes("on this machine")), "and where it goes");

  // Picking one is an ordinary re-plan: a different cache key, so it renders
  // from that model's cache, sends under its grant, or asks — the plan decides.
  const before = sent.length;
  options.find((o) => o.textContent.includes("Gemma 4 E4B")).click();
  await settle();
  const replanned = sent.slice(before).find((m) => m.type === "plan");
  assert.equal(replanned.providerId, "ollama");
});

await test("a section's body lines never reach the wire", async () => {
  const sent = stubBrowser((message) =>
    message.type === "plan"
      ? { ...PLAN, consented: true }
      : { sections: [], tldr: "t", model: "gemini-3.8-flash" });
  const root = new FakeNode("div");
  const pane = createOutlinePane({ root, onJump() {}, onSections() {} });
  // Lines are carried so a bullet can be located against the paper; they are
  // the same words as `text` and the model payload is built from `text`, so
  // sending them would put the paper on the wire twice for nothing.
  pane.start({
    hash: "abc",
    meta: {},
    sections: [{ title: "1 Intro", page: 1, y: 700, text: "words here",
      lines: [{ page: 1, y: 690, height: 9, str: "words here" }] }],
  });
  await settle();

  assert.ok(sent.length >= 2, "planned and sent");
  for (const message of sent) {
    for (const section of message.sections ?? []) {
      assert.equal(section.lines, undefined, `${message.type} carried body lines`);
      assert.equal(section.text, "words here", "while the text the model needs is intact");
    }
  }
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
