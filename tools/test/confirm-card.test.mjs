// CLAUDE.md names exactly what the confirmation has to state: title, page count,
// section count, approximate token count, provider label, model id, and whether
// the text leaves the machine. That is a contract about rendered words, so it is
// tested over rendered words — against a DOM small enough to keep in this file.
import assert from "node:assert/strict";

import { FakeNode } from "./dom.mjs";

const { confirmCard } = await import("../../src/viewer/confirm-card.js");

const PLAN = {
  title: "BERT: Pre-training of Deep Bidirectional Transformers",
  pageCount: 16,
  sectionCount: 19,
  sectionTitles: ["Abstract", "1 Introduction", "References should not be here"].slice(0, 2),
  estTokens: 9263,
  requests: 1,
  label: "Gemini 3.8 Flash",
  model: "gemini-3.8-flash",
  destination: "google",
  host: "generativelanguage.googleapis.com",
  estCost: 0.0107,
  hasKey: true,
  alternatives: [{ id: "ollama", label: "Gemma 4 E4B (local)", destination: "local" }],
};

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

test("the card states every fact CLAUDE.md requires of it", () => {
  const text = confirmCard(PLAN, { onConfirm() {}, onPickProvider() {} }).textContent;
  for (const fragment of ["BERT:", "16 pages", "19 sections", "9,263 tokens", "Gemini 3.8 Flash", "gemini-3.8-flash"]) {
    assert.ok(text.includes(fragment), `the card never says "${fragment}"`);
  }
  assert.ok(text.includes("Sent to Google"), "the card must say the text leaves the machine");
  assert.ok(text.includes("1.1¢"), `cost estimate missing from: ${text}`);
  assert.ok(text.includes("1 Introduction"), "the section titles are what gets sent");
});

test("the local provider is described as staying on the machine", () => {
  const local = { ...PLAN, destination: "local", label: "Gemma 4 E4B (local)", model: "gemma4:e4b",
    host: "127.0.0.1:11434", estCost: null, hasKey: false, alternatives: [] };
  const text = confirmCard(local, { onConfirm() {}, onPickProvider() {} }).textContent;
  assert.ok(text.includes("Stays on this machine"), text);
  assert.ok(text.includes("127.0.0.1:11434"), text);
  assert.ok(!text.includes("¢"), "no pricing on the descriptor means no cost line");
  assert.ok(!text.includes("No API key"), "the local provider needs no key");
});

test("nothing happens until the button is pressed, and then exactly once", () => {
  let confirms = 0;
  let picked = null;
  const card = confirmCard(PLAN, { onConfirm: () => confirms++, onPickProvider: (id) => (picked = id) });
  assert.equal(confirms, 0, "rendering the card must not confirm anything");
  card.find("confirm-go").click();
  assert.equal(confirms, 1);
  // Another destination re-plans and asks again; it never proceeds on its own.
  card.find("confirm-alt-go").click();
  assert.equal(picked, "ollama");
  assert.equal(confirms, 1, "choosing another destination is not a confirmation");
});

test("a missing key is stated on the card but does not disable the grant", () => {
  const card = confirmCard({ ...PLAN, hasKey: false }, { onConfirm() {}, onPickProvider() {} });
  assert.ok(card.textContent.includes("No API key is stored"), card.textContent);
  assert.notEqual(card.find("confirm-go").disabled, true);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
