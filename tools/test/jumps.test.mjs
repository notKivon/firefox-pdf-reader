import "./test-providers.mjs";
// Better jumps (2026-11-19): a bullet's quote places it on its sentence, the
// band covers only that column, chat citations can carry a quote, and Back
// returns to the reading spot from before the first of a run of jumps.
import assert from "node:assert/strict";
import { FakeNode } from "./dom.mjs";

globalThis.document = { createElement: (tag) => new FakeNode(tag) };
const keyListeners = [];
globalThis.window = { addEventListener: (type, fn) => type === "keydown" && keyListeners.push(fn) };

const { locateQuote } = await import("../../src/viewer/locate-quote.js");
const { outlineList } = await import("../../src/viewer/outline-list.js");
const { splitCitations } = await import("../../src/model/chat-prompt.js");
const { messageNode } = await import("../../src/viewer/chat-render.js");
const { createBackJump } = await import("../../src/viewer/back-jump.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

// One section of a two-column page: left-column lines at x 50–300, a
// right-column stretch at x 312–560, and a hyphen split across lines.
const lines = [
  ["We tabulate the cumulative kernel once on a regular", 5, 700, 50, 300],
  ["grid and reuse it for every particle in the snapshot.", 5, 688, 50, 300],
  ["The median relative error of the voxelised density is about", 5, 676, 312, 560],
  ["four parts in a hundred thousand for a lookup table of", 5, 664, 312, 560],
  ["129 points per dimension, independent of the smooth-", 5, 652, 312, 560],
  ["ing length distribution.", 6, 720, 50, 300],
].map(([str, page, y, x, right]) => ({ str, page, y, height: 10, x, right }));

test("an exact quote lands on its lines and its column only", () => {
  const hit = locateQuote("median relative error of the voxelised density is about four parts", lines);
  assert.deepEqual(hit, { page: 5, y: 676, yEnd: 664, height: 10, x: 312, xEnd: 560 });
});

test("a quote survives a hyphen split, a symbol the text layer lost, and a page break", () => {
  const hit = locateQuote("independent of the smoothing length distribution", lines);
  assert.equal(hit.y, 652, "starts on the line the quote starts on");
  assert.equal(hit.page, 5, "a span across a page break is reported where it starts");
  const fuzzy = locateQuote("four parts in a hundred thousand for a lookup table of 129³ points", lines);
  assert.ok(fuzzy && fuzzy.y === 664, "most of the words in order is enough");
});

test("a quote that is not in the section places nothing", () => {
  assert.equal(locateQuote("the Hubble constant is seventy kilometres per second", lines), null);
  assert.equal(locateQuote("median error", lines), null, "too short to mean anything");
  assert.equal(locateQuote("tabulate snapshot median hundred smoothing distribution", lines), null, "words scattered across the section are not a quote");
});

test("a bullet goes to its quote's sentence before its own words or its heading", () => {
  const jumps = [];
  const rendered = outlineList(
    {
      sections: [{
        title: "4.2 Accuracy", page: 5, y: 712,
        bullets: ["Errors are tiny for a modest table.", "The cumulative kernel sits on a regular grid used for every particle."],
        quotes: ["median relative error of the voxelised density is about four parts", ""],
      }],
    },
    { onJump: (t) => jumps.push(t), linesFor: () => lines },
  );
  const [first, second] = rendered.node.findAll("outline-bullet-go");
  first.click();
  second.click();
  assert.deepEqual(jumps[0], { page: 5, y: 676, yEnd: 664, height: 10, x: 312, xEnd: 560 });
  assert.equal(jumps[1].y, 700, "no quote: the bullet's own words still place it");
});

test("a chat citation with a quote links to the sentence; without one, to the heading", () => {
  const sections = [{ title: "4.2 Accuracy", page: 5, y: 712, lines }];
  const parts = splitCitations('So [§ 4.2 Accuracy | "the median relative error of the voxelised density is about"] and [§ 4.2 Accuracy].', sections);
  assert.equal(parts[1].quote, "the median relative error of the voxelised density is about");
  assert.equal(parts[3].quote, undefined);
  const jumps = [];
  const node = messageNode({ role: "assistant", content: 'See [§ 4.2 Accuracy | "the median relative error of the voxelised density is about"] and [§ 4.2 Accuracy].' }, sections, (t) => jumps.push(t));
  for (const link of node.findAll("chat-cite")) link.click();
  assert.equal(jumps[0].y, 676);
  assert.deepEqual(jumps[1], { page: 5, y: 712 });
  const missing = messageNode({ role: "assistant", content: '[§ 4.2 Accuracy | "words that are nowhere in this section at all"]' }, sections, (t) => jumps.push(t));
  missing.find("chat-cite").click();
  assert.deepEqual(jumps[2], { page: 5, y: 712 }, "a quote not found falls back to the heading");
});

test("Back returns to the spot before the first of a run of jumps, zoom or not", () => {
  const container = { scrollTop: 1000, scrollLeft: 0, scrollHeight: 10_000 };
  const button = new FakeNode("button");
  const back = createBackJump({ container, button });
  assert.equal(button.hidden, true, "nothing to go back to yet");
  back.remember();
  container.scrollTop = 6000;
  back.remember();
  container.scrollTop = 7000;
  assert.equal(button.hidden, false);
  container.scrollHeight = 20_000; // zoomed in meanwhile
  button.click();
  assert.equal(container.scrollTop, 2000, "the first spot, as a share of the height");
  assert.equal(button.hidden, true);
  back.remember();
  for (const fn of keyListeners) fn({ key: "Escape", preventDefault() {} });
  assert.equal(button.hidden, true, "Escape lets the reader stay where they jumped");
  assert.equal(back.pending, false);
});

test("a quote survives ligature breaks, Greek written out, and a table inside the sentence", () => {
  const broken = [
    ["Results indicate that spill over is not signi", 1, 435, 203, 304],
    ["ficant at the aggregate level, while the di", 1, 425, 203, 558],
    ["fferential dependence of sectors is clear.", 1, 415, 203, 558],
    ["For the DCC model the estimated coefficients", 2, 600, 38, 290],
    ["θ1 and θ2 are found to be statistically significant for all sectors", 2, 590, 38, 290],
    ["Table 1", 2, 580, 38, 80],
    ["Descriptive statistics of return series", 2, 570, 38, 200],
    ["OIL SEN AUTO EN FIN METAL POWER O G", 2, 560, 38, 290],
    ["Mean 0.0021 0.0029 0.0017 0.0033 0.0012 0.0008 0.0019", 2, 550, 38, 290],
    ["Std 0.041 0.032 0.039 0.044 0.051 0.047 0.038", 2, 540, 38, 290],
    ["except EN and O & G sectors.", 2, 530, 38, 290],
  ].map(([str, page, y, x, right]) => ({ str, page, y, height: 10, x, right }));
  assert.equal(locateQuote("spill over is not significant at the aggregate level", broken)?.y, 435, "signi|ficant rejoined");
  assert.equal(locateQuote("at the aggregate level, while the differential dependence of sectors is clear", broken)?.y, 425, "di|fferential rejoined");
  const theta = locateQuote("the estimated coefficients theta1 and theta2 are found to be statistically significant for all sectors except EN and O & G", broken);
  assert.equal(theta?.y, 600, "θ read as theta; the table inside the sentence does not lose it");
});

console.log(results.join("\n"));
console.log(`\njumps: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
