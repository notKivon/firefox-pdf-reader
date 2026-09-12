// The scroll-spy's one real decision: which section the reader is in. The
// scheduling around it is rAF and pdf.js; this is the part that can be wrong
// quietly, by highlighting a section the reader has not reached.
import assert from "node:assert/strict";

const { activeIndex } = await import("../../src/viewer/scroll-spy.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

const OFFSETS = [0, 400, 1200, 3000];

test("the current section is the last heading the reader has passed", () => {
  assert.equal(activeIndex(OFFSETS, 0), 0);
  assert.equal(activeIndex(OFFSETS, 399), 0);
  assert.equal(activeIndex(OFFSETS, 400), 1, "a heading exactly on the line has been reached");
  assert.equal(activeIndex(OFFSETS, 2999), 2);
  assert.equal(activeIndex(OFFSETS, 99999), 3, "past the last heading it stays the last");
});

test("above the first heading, no section is current", () => {
  assert.equal(activeIndex(OFFSETS, -50), -1);
  assert.equal(activeIndex([], 500), -1);
});

test("a section that cannot be measured is skipped, not treated as passed", () => {
  // pdf.js has not laid that page out yet. It says nothing about where the
  // reader is, so the last *measurable* heading above the line wins.
  assert.equal(activeIndex([0, null, 1200, 3000], 1500), 2);
  assert.equal(activeIndex([0, 400, null, 3000], 1500), 1);
  assert.equal(activeIndex([null, null], 1500), -1);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
