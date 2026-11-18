import "./test-providers.mjs";
// The chat tab (step 22): nothing leaves without its own approval, the gate is
// the router's, the conversation is kept per paper, and a section link's target
// is the extracted section's — never anything the model said.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeNode } from "./dom.mjs";
import { installIndexedDb } from "./idb.mjs";
import { installFetch } from "./stub.mjs";

installIndexedDb();
const store = { apiKeys: { gemini: "test-key-not-a-real-one", "claude-bridge": "srb_test_token" } };
let routerListener;
const progress = [];
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
globalThis.browser = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async () => {} } },
  runtime: {
    onMessage: { addListener: (fn) => { routerListener = fn; } },
    sendMessage: async (message) => routerListener(message, { tab: { id: 4 } }),
  },
  tabs: { sendMessage: async (_tab, message) => { progress.push(message); chatPane?.progress(message); } },
};

const { registerRouter } = await import("../../src/background/router.js");
registerRouter({ bypass: { grant: () => true } });
const { ask } = await import("../../src/viewer/ask.js");
const { chatKey, cacheKey } = await import("../../src/store/cache-key.js");
const { splitCitations } = await import("../../src/model/chat-prompt.js");
const { createChatPane } = await import("../../src/viewer/chat-pane.js");
let chatPane = null;

const { sections } = JSON.parse(readFileSync(new URL("../../fixtures/adam.json", import.meta.url), "utf8"));
const meta = { title: "Adam", pageCount: 15 };
const settle = () => new Promise((r) => setTimeout(r, 0));
const hashOf = (c) => c.repeat(64);
const say = (text) => installFetch(() => new Response(
  new Blob([`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`]).stream(),
  { status: 200 },
));

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

await test("a question without a chat approval is refused and sends nothing", async () => {
  const calls = say("never");
  const hash = hashOf("1");
  const answer = await routerListener({ type: "chat", hash, sections, meta, question: "What is Adam?" }, {});
  assert.equal(answer.error, "consent-required");
  assert.equal(answer.plan.cacheKey, chatKey(hash, "claude-opus"), "Opus by default");
  assert.equal(calls.length, 0);
});

await test("an outline approval does not cover chat, and the local model does not chat", async () => {
  const hash = hashOf("2");
  await ask({ type: "grant", hash, providerId: "claude-opus", cacheKey: cacheKey(hash, "claude-opus") });
  const calls = say("never");
  const answer = await routerListener({ type: "chat", hash, sections, meta, question: "Hi" }, {});
  assert.equal(answer.error, "consent-required", "a different thing is being sent");
  assert.equal(calls.length, 0);
  await assert.rejects(
    ask({ type: "grant", kind: "chat", hash, providerId: "ollama", cacheKey: chatKey(hash, "ollama") }),
    /does not chat/,
  );
  await assert.rejects(ask({ type: "chat-plan", hash, sections, meta, providerId: "ollama" }), /does not chat/);
});

await test("after the grant: the paper goes as the system prompt, and the turns are kept", async () => {
  const hash = hashOf("3");
  await ask({ type: "grant", kind: "chat", hash, providerId: "claude-opus", cacheKey: chatKey(hash, "claude-opus") });
  let calls = say("Adam adapts step sizes [§ 2 ALGORITHM].");
  const first = await ask({ type: "chat", hash, sections, meta, question: "What is Adam?" });
  assert.equal(first.reply, "Adam adapts step sizes [§ 2 ALGORITHM].");
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(body.response_format, undefined, "plain text, no schema");
  assert.equal(calls[0].url, "http://127.0.0.1:8765/v1/chat/completions");
  assert.match(body.messages[0].content, /Title: 2 ALGORITHM/);
  assert.doesNotMatch(body.messages[0].content, /^Title: REFERENCES/m, "the reference list never goes");
  assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "What is Adam?" }]);
  assert.ok(progress.some((m) => m.type === "chat-progress" && m.hash === hash), "the reply streams to the tab");

  calls = say("Yes.");
  await ask({ type: "chat", hash, sections, meta, question: "Does it need tuning?" });
  assert.deepEqual(calls[0].body.messages.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  const { messages } = await ask({ type: "chat-history", hash });
  assert.equal(messages.length, 4);
  assert.equal(messages[1].model, "claude-opus-5-5");

  await ask({ type: "chat-clear", hash });
  assert.equal((await ask({ type: "chat-history", hash })).messages.length, 0);
});

await test("a failed reply leaves the conversation as it was", async () => {
  const hash = hashOf("4");
  await ask({ type: "grant", kind: "chat", hash, providerId: "claude-opus", cacheKey: chatKey(hash, "claude-opus") });
  installFetch(() => new Response(JSON.stringify({ error: { message: "You've hit your usage limit." } }), {
    status: 429,
    headers: { "retry-after": "60" },
  }));
  const answer = await routerListener({ type: "chat", hash, sections, meta, question: "Q" }, {});
  assert.equal(answer.error, "rate-limit");
  assert.match(answer.message, /usage limit/);
  assert.equal((await ask({ type: "chat-history", hash })).messages.length, 0);
});

await test("citations link only to sections that exist, at the extraction's position", () => {
  const list = [{ title: "2 Method", page: 3, y: 100 }, { title: "3 Results", page: 5, y: 40 }];
  const parts = splitCitations("See [§ 2 method] and [§ 9 Nowhere], then [§  3 Results ].", list);
  assert.deepEqual(parts, [
    { text: "See " },
    { cite: "2 Method", index: 0 },
    { text: " and [§ 9 Nowhere], then " },
    { cite: "3 Results", index: 1 },
    { text: "." },
  ]);
});

await test("the pane says where Send goes, and Send records the grant and sends", async () => {
  const hash = hashOf("5");
  const jumps = [];
  const root = new FakeNode("div");
  chatPane = createChatPane({ root, onJump: (t) => jumps.push(t) });
  await chatPane.start({ hash, meta, sections, scanned: false });
  for (let i = 0; i < 20 && !root.find("chat-input"); i++) await settle();
  assert.match(root.find("chat-where").textContent, /Send shares this paper .* with Anthropic \(Claude Opus 5\.5\), through Claude Code/);
  const input = root.find("chat-input");
  input.value = "What is new?";
  const calls = say("It corrects bias [§ 3 INITIALIZATION BIAS CORRECTION].");
  assert.equal(calls.length, 0, "nothing before Send");

  root.find("chat-send").click();
  for (let i = 0; i < 50 && !root.find("chat-cite"); i++) await settle();
  assert.equal(root.find("chat-card"), null, "no second confirmation: Send is the approval");
  assert.equal(calls.length, 1);
  const { consents } = await ask({ type: "consents" });
  assert.ok(consents.some((c) => c.key === chatKey(hash, "claude-opus") && c.kind === "chat"), "the grant is on record");
  const cite = root.find("chat-cite");
  assert.ok(cite, root.textContent);
  cite.click();
  const section = sections.find((s) => s.title === "3 INITIALIZATION BIAS CORRECTION");
  assert.deepEqual(jumps, [{ page: section.page, y: section.y }], "the target is the extracted section's");
  assert.equal(input.value, "", "the box empties once answered");
  chatPane = null;
});

await test("Gemini 4 chats too: straight to Google with the Gemini key, counted", async () => {
  const hash = hashOf("7");
  const { used } = await import("../../src/store/quota.js");
  const before = await used("gemini-4-hydrogen");
  await ask({ type: "grant", kind: "chat", hash, providerId: "gemini-4-hydrogen", cacheKey: chatKey(hash, "gemini-4-hydrogen") });
  const calls = say("An answer.");
  const answer = await ask({ type: "chat", hash, sections, meta, providerId: "gemini-4-hydrogen", question: "Q?" });
  assert.equal(answer.reply, "An answer.");
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(calls[0].model, "gemini-4-hydrogen");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key-not-a-real-one");
  assert.equal(await used("gemini-4-hydrogen"), before + 1);
  const plan = await ask({ type: "chat-plan", hash, sections, meta, providerId: "gemini-4-hydrogen" });
  assert.equal(plan.destination, "google");
  assert.ok(plan.providers.every((p) => p.id !== "ollama"), "the local model does not chat");
});

await test("Opus at its usage limit stops; no other model is tried on its own", async () => {
  const { outline } = await import("../../src/model/adapter.js");
  const { DEFAULT_ORDER } = await import("../../src/store/settings.js");
  const calls = installFetch(() => new Response("{}", { status: 429 }));
  await assert.rejects(
    outline({ sections, providerId: "claude-opus", resolveKey: async () => "k", order: DEFAULT_ORDER }),
    (err) => {
      assert.equal(err.kind, "exhausted");
      assert.deepEqual(err.tried, ["claude-opus"]);
      return true;
    },
  );
  assert.equal(calls.length, 1, "Sonnet and Haiku are the reader's choice, not a fallback");
});

await test("New chat asks once in the pane, then clears the conversation", async () => {
  const hash = hashOf("8");
  await ask({ type: "grant", kind: "chat", hash, providerId: "claude-opus", cacheKey: chatKey(hash, "claude-opus") });
  say("First answer.");
  await ask({ type: "chat", hash, sections, meta, question: "First?" });
  const root = new FakeNode("div");
  const pane = createChatPane({ root, onJump: () => {} });
  await pane.start({ hash, meta, sections, scanned: false });
  for (let i = 0; i < 20 && !root.find("chat-new"); i++) await settle();
  assert.match(root.find("chat-log").textContent, /First answer/);

  root.find("chat-new").click();
  const prompt = root.find("chat-new-prompt");
  assert.ok(prompt, "asked in the pane, never a dialog");
  assert.match(prompt.textContent, /1 question/);
  prompt.find("confirm-alt-go").click();
  assert.equal(root.find("chat-new-prompt"), null, "Keep this one keeps it");
  assert.equal((await ask({ type: "chat-history", hash })).messages.length, 2);

  root.find("chat-new").click();
  root.find("chat-new-prompt").find("confirm-go").click();
  for (let i = 0; i < 20 && /First answer/.test(root.find("chat-log").textContent); i++) await settle();
  assert.doesNotMatch(root.find("chat-log").textContent, /First answer/);
  assert.equal((await ask({ type: "chat-history", hash })).messages.length, 0);
});

await test("once an outline is up, chat links point at its sections", async () => {
  const hash = hashOf("9");
  const jumps = [];
  const root = new FakeNode("div");
  const pane = createChatPane({ root, onJump: (t) => jumps.push(t) });
  await pane.start({ hash, meta, sections, scanned: false });
  for (let i = 0; i < 20 && !root.find("chat-input"); i++) await settle();
  pane.useSections([{ title: "Title and abstract", page: 1, y: 720, text: "Adam is an optimiser.", lines: [] }]);
  await ask({ type: "grant", kind: "chat", hash, providerId: "claude-opus", cacheKey: chatKey(hash, "claude-opus") });
  const calls = say("See [§ Title and abstract].");
  root.find("chat-input").value = "Summary?";
  root.find("chat-send").click();
  for (let i = 0; i < 50 && !root.find("chat-cite"); i++) await settle();
  assert.match(calls[0].body.messages[0].content, /Title: Title and abstract\n\nAdam is an optimiser\./);
  root.find("chat-cite").click();
  assert.deepEqual(jumps, [{ page: 1, y: 720 }]);
});

await test("a scanned paper offers no chat and sends nothing", async () => {
  const root = new FakeNode("div");
  const pane = createChatPane({ root, onJump: () => {} });
  const calls = say("never");
  await pane.start({ hash: hashOf("6"), meta, sections, scanned: true });
  assert.match(root.textContent, /scanned PDF/);
  assert.equal(calls.length, 0);
});

console.log(results.join("\n"));
console.log(`\nchat: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
