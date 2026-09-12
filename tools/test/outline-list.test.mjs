// What the outline renders and where a click sends the reader.
//
// The jump targets are the thing worth pinning: CLAUDE.md has `page`/`y` come
// from the extracted section and never from the model, and a bullet that scrolls
// to the wrong place looks exactly like one that scrolls to the right place.
import assert from "node:assert/strict";
import { FakeNode } from "./dom.mjs";

globalThis.document = { createElement: (tag) => new FakeNode(tag) };

const { outlineList } = await import("../../src/viewer/outline-list.js");

const RESULT = {
  tldr: "Adam is a first-order method with per-parameter adaptive learning rates.",
  model: "gemini-3.8-flash",
  sections: [
    { title: "1 Introduction", page: 1, y: 700, bullets: ["Stochastic optimisation is central.", "Adam needs little tuning."] },
    { title: "2 Algorithm", page: 2, y: 512, bullets: ["Keeps running averages of gradient and its square."] },
    // Kept by the extractor, never sent: a heading whose subsection follows it.
    { title: "3 Analysis", page: 4, y: 300, bullets: [] },
    { title: "4 Experiments", page: 6, y: 180, bullets: [], error: "The model's answer for this section could not be parsed." },
  ],
};

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

test("every section is rendered with its extracted title and page", () => {
  const { node } = outlineList(RESULT, {});
  const blocks = node.findAll("outline-section");
  assert.equal(blocks.length, 4);
  const titles = node.findAll("outline-title-text").map((n) => n.textContent);
  assert.deepEqual(titles, ["1 Introduction", "2 Algorithm", "3 Analysis", "4 Experiments"]);
  assert.deepEqual(node.findAll("outline-page").map((n) => n.textContent), ["p1", "p2", "p4", "p6"]);
  assert.ok(node.find("outline-tldr-text").textContent.startsWith("Adam is a first-order"));
});

test("a bullet jumps to its own section, exactly where the heading does", () => {
  const jumps = [];
  const { node, targets } = outlineList(RESULT, { onJump: (t) => jumps.push(t) });

  const bullets = node.findAll("outline-bullet-go");
  assert.equal(bullets.length, 3, "two bullets in section 1, one in section 2");
  bullets[1].click(); // the second bullet of the first section
  bullets[2].click(); // the only bullet of the second
  node.findAll("outline-title")[0].click();

  assert.deepEqual(jumps, [
    { page: 1, y: 700 },
    { page: 2, y: 512 },
    { page: 1, y: 700 },
  ]);
  // The same targets the scroll-spy measures against, in section order.
  assert.deepEqual(targets, [
    { page: 1, y: 700 },
    { page: 2, y: 512 },
    { page: 4, y: 300 },
    { page: 6, y: 180 },
  ]);
});

test("a failed section and an empty one never render the same way", () => {
  const { node } = outlineList(RESULT, {});
  assert.equal(node.findAll("outline-section-empty").length, 1, "3 Analysis has nothing of its own");
  const failed = node.findAll("outline-section-error");
  assert.equal(failed.length, 1, "4 Experiments failed and must say so");
  assert.ok(failed[0].textContent.includes("could not be parsed"));
});

test("a partial render says a section is still being written", () => {
  const { node } = outlineList({ sections: [{ title: "5 Results", page: 8, y: 90, bullets: [] }] }, { partial: true });
  assert.equal(node.find("outline-section-empty"), null, "nothing has been established about it yet");
  assert.ok(node.find("outline-section-pending"));
});

test("exactly one section is current at a time, and -1 clears it", () => {
  const { node, setActive } = outlineList(RESULT, {});
  const blocks = node.findAll("outline-section");

  setActive(1);
  assert.deepEqual(blocks.map((b) => b.classList.contains("is-current")), [false, true, false, false]);
  setActive(3);
  assert.deepEqual(blocks.map((b) => b.classList.contains("is-current")), [false, false, false, true]);
  // Above the first heading no section is the current one, and saying otherwise
  // would be a lie about where the reader is.
  setActive(-1);
  assert.deepEqual(blocks.map((b) => b.classList.contains("is-current")), [false, false, false, false]);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
