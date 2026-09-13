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

// ---- reported live 2026-09-13: the pane's text could not be selected or copied
test("a bullet is selectable text, not a button label", () => {
  const rendered = outlineList(RESULT, {});
  const bullet = rendered.node.find("outline-bullet-go");
  const heading = rendered.node.find("outline-title");
  // The whole reason this is not a <button>: a button's label cannot be
  // selected, and these bullets are prose the reader wants to quote.
  assert.notEqual(bullet.tag, "button", "a bullet must not be a button");
  assert.notEqual(heading.tag, "button", "nor a heading");
  // The affordance a button gave for free, kept by hand.
  assert.equal(bullet.getAttribute("role"), "button");
  assert.equal(bullet.tabIndex, 0, "still a tab stop");
  assert.equal(heading.getAttribute("role"), "button");
  assert.equal(heading.tabIndex, 0);
});

test("Enter and Space still jump; other keys do not", () => {
  const jumps = [];
  const rendered = outlineList(RESULT, { onJump: (t) => jumps.push(t) });
  const bullet = rendered.node.find("outline-bullet-go");

  assert.equal(bullet.keydown("Enter"), true, "Enter is handled, so it is prevented");
  assert.equal(bullet.keydown(" "), true, "Space too — it would otherwise scroll");
  assert.equal(jumps.length, 2);
  assert.equal(bullet.keydown("a"), false, "typing is not activation");
  assert.equal(jumps.length, 2);
});

test("a click that ends a text selection does not jump the paper", () => {
  const jumps = [];
  const rendered = outlineList(RESULT, { onJump: (t) => jumps.push(t) });
  const bullet = rendered.node.find("outline-bullet-go");

  // A drag that selects inside the bullet still fires a click. Jumping then
  // would throw the reader's place away at the moment they went to copy.
  const selected = { isCollapsed: false, toString: () => "some words", anchorNode: bullet, focusNode: bullet };
  bullet.ownerDocument = { defaultView: { getSelection: () => selected } };
  bullet.click();
  assert.equal(jumps.length, 0, "selecting is not clicking");

  // A collapsed selection — an ordinary click — still jumps.
  bullet.ownerDocument = { defaultView: { getSelection: () => ({ isCollapsed: true, toString: () => "" }) } };
  bullet.click();
  assert.equal(jumps.length, 1);
});

test("LaTeX the model wrote is unwrapped, and reported numbers survive", () => {
  const rendered = outlineList(
    {
      tldr: "The model $\\mathbf{z}$ is trained.",
      sections: [{ title: "3 RESULTS", page: 4, y: 600, bullets: ["Reaches $28.4$ BLEU with \\mathbf{x}."] }],
    },
    {},
  );
  const bullet = rendered.node.find("outline-bullet-go");
  assert.equal(bullet.textContent, "Reaches 28.4 BLEU with x.");
  assert.equal(rendered.node.find("outline-tldr-text").textContent, "The model z is trained.");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
