// The confirmation says what would be sent and where — the model, what leaves
// the machine and for whom, and a cost where one is known — and nothing else
// (2026-11-21, at the user's request: the title, token counts and model ids
// were noise). That is a contract about rendered words, so it is tested over
// rendered words, against a DOM small enough to keep in this file.
import assert from "node:assert/strict";

import { FakeNode } from "./dom.mjs";

const { confirmCard } = await import("../../src/viewer/confirm-card.js");

const PLAN = {
  providerId: "gemini-4-hydrogen",
  title: "BERT: Pre-training of Deep Bidirectional Transformers",
  pageCount: 16,
  sectionCount: 19,
  sectionTitles: ["Abstract", "1 Introduction"],
  estTokens: 9263,
  requests: 1,
  label: "Gemini 4 Hydrogen",
  model: "gemini-4-hydrogen",
  destination: "google",
  host: "generativelanguage.googleapis.com",
  estCost: 0.0107,
  hasKey: true,
  otherProviders: [
    { id: "claude-opus", label: "Claude Opus 5.5 (via Claude Code)", destination: "anthropic" },
    { id: "ollama", label: "Gemma 4 E4B (local)", destination: "local" },
  ],
};

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

const card = (plan, handlers = { onConfirm() {}, onPickProvider() {} }) => confirmCard(plan, handlers);

test("one question, one fact, one action — and no noise", () => {
  const node = card(PLAN);
  const text = node.textContent;
  assert.match(node.find("confirm-ask").textContent, /^Outline with/);
  assert.equal(node.find("confirm-fact").textContent.trim().startsWith("Sends 19 sections of text to Google."), true, text);
  assert.ok(text.includes("1.1¢"), "a known price is said");
  for (const noise of ["BERT:", "tokens", "gemini-4-hydrogen", "via Claude Code", "request"]) {
    assert.ok(!text.includes(noise), `the card should not say "${noise}": ${text}`);
  }
  assert.equal(node.findAll("confirm-go").length, 1);
});

test("the model is the one choice, current model selected, grouped by destination", () => {
  const node = card(PLAN);
  const select = node.find("confirm-model-select");
  assert.equal(node.find("confirm-model-name").textContent, "Gemini 4 Hydrogen", "the chosen name is shown as text");
  const options = select.options();
  assert.deepEqual(options.map((o) => o.value), ["claude-opus", "gemini-4-hydrogen", "ollama"]);
  assert.equal(options.find((o) => o.selected).value, "gemini-4-hydrogen");
  assert.equal(options[0].textContent, "Claude Opus 5.5", "no \"via Claude Code\"");
});

test("a PDF sent to Claude is said as the PDF, with no cost on a subscription", () => {
  const opus = { ...PLAN, providerId: "claude-opus", label: "Claude Opus 5.5 (via Claude Code)", destination: "anthropic",
    bridge: true, estCost: null, modelSections: true, sectionTitles: [], pdf: { pages: 18, size: 1_800_000 }, otherProviders: [] };
  const node = card(opus);
  assert.equal(node.find("confirm-ask").textContent, "Outline with Claude Opus 5.5");
  assert.equal(node.find("confirm-fact").textContent, "Sends the 18-page PDF to Anthropic.");
  assert.equal(node.find("confirm-what"), null, "no section list when the model chooses the sections");
});

test("the local provider is described as staying on the machine", () => {
  const local = { ...PLAN, providerId: "ollama", destination: "local", label: "Gemma 4 E4B (local)", estCost: null, hasKey: false };
  const text = card(local).textContent;
  assert.ok(text.includes("Stays on this machine"), text);
  assert.ok(!text.includes("¢"), "no pricing on the descriptor means no cost");
  assert.ok(!text.includes("Settings"), "the local provider needs no key");
});

test("nothing happens until the button is pressed, and then exactly once", () => {
  let confirms = 0;
  let picked = null;
  const node = card(PLAN, { onConfirm: () => confirms++, onPickProvider: (id) => (picked = id) });
  assert.equal(confirms, 0, "rendering the card must not confirm anything");
  node.find("confirm-go").click();
  assert.equal(confirms, 1);
  // Another model re-plans and asks again; it never proceeds on its own.
  node.find("confirm-model-select").choose("ollama");
  assert.equal(picked, "ollama");
  assert.equal(confirms, 1, "choosing another model is not a confirmation");
});

test("a missing key is stated on the card but does not disable the grant", () => {
  const node = card({ ...PLAN, hasKey: false });
  assert.ok(node.textContent.includes("Add your API key in Settings first."), node.textContent);
  assert.notEqual(node.find("confirm-go").disabled, true);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
