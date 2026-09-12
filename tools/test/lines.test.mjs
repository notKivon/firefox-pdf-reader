// Line assembly around super/subscripts.
//
// The bug this pins was found on a real paper: a subscript became a line of its
// own and landed in the text away from the words it belonged to. Groups were
// anchored on the first item's y, and because items sort by y a raised
// superscript opens the group — leaving a subscript on the same visual line
// further from that anchor than the tolerance allows.
//
// The guard cases matter as much as the bug: the reach that lets a small run
// join its line must never let two lines of body text merge.
import assert from "node:assert/strict";

const { groupLines } = await import("../../src/extract/lines.js");

// 10pt body text, so the tolerance callers use is 0.4 × 10 = 4pt.
const BODY = 10;
const TOL = 0.4 * BODY;
const it = (str, x, y, w, h) => ({ str, x, y, width: w, height: h, pdfY: 800 - y, fontName: "f1", fontFamily: "" });
const texts = (items) => groupLines(items, TOL, { pageNumber: 1 }).map((l) => l.str);

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

test("a superscript and a subscript on one line stay on that line", () => {
  const line = [
    it("x", 50, 100, 6, BODY),
    it("2", 56, 96.7, 3.5, 7), // raised 3.3pt, 7pt type
    it(" + y", 60, 100, 15, BODY),
    it("1", 75, 102.2, 3.5, 7), // dropped 2.2pt — the one that used to strand
  ];
  assert.deepEqual(texts([...line, it("and so on", 50, 112, 40, BODY)]), ["x2 + y1", "and so on"]);
});

test("the line's baseline is its body text's, not the superscript's", () => {
  // Everything downstream orders lines by this y, and a jump target is derived
  // from the line, so anchoring on a raised run skews both.
  const [line] = groupLines([it("2", 56, 96.7, 3.5, 7), it("x", 50, 100, 6, BODY)], TOL, {});
  assert.equal(line.y, 100);
  assert.equal(line.height, BODY);
});

test("a subscript with no superscript still joins, as it always did", () => {
  assert.deepEqual(texts([it("H", 50, 100, 6, BODY), it("2", 56, 102.2, 3.5, 7), it("O", 60, 100, 6, BODY)]), ["H2O"]);
});

test("two lines of body text never merge", () => {
  // The whole risk of giving small runs extra reach. Real leading is ~1.1 × body
  // and the reach is 0.64 × body, but the size test is what makes it impossible:
  // neither line is small relative to the other.
  assert.deepEqual(
    texts([it("first line here", 50, 100, 60, BODY), it("second line here", 50, 105, 60, BODY)]),
    ["first line here", "second line here"],
    "even at 5pt apart, closer than any real leading",
  );
});

test("a smaller line below body text stays its own line", () => {
  // A footnote is small *and* below, which is what a subscript looks like. Its
  // distance is what separates them.
  assert.deepEqual(
    texts([it("body text ends here", 50, 100, 70, BODY), it("1 A footnote in smaller type", 50, 112, 80, 8)]),
    ["body text ends here", "1 A footnote in smaller type"],
  );
});

test("a run only slightly smaller is a size change, not a script", () => {
  // 9pt against 10pt is 0.9 — above the ratio, so it gets no extra reach and
  // stays a line of its own.
  assert.deepEqual(
    texts([it("body text", 50, 100, 40, BODY), it("nearly the same size", 50, 106, 70, 9)]),
    ["body text", "nearly the same size"],
  );
});

test("scripts are marked with the level the paper set them at", () => {
  const [line] = groupLines([
    it("x", 50, 100, 6, BODY),
    it("2", 56, 96.7, 3.5, 7),
    it("y", 60, 100, 6, BODY),
    it("1", 66, 102.2, 3.5, 7),
  ], TOL, {});
  assert.deepEqual(
    line.runs.map((r) => [r.str.trim(), r.script]),
    [["x", null], ["2", "sup"], ["y", null], ["1", "sub"]],
  );
  assert.equal(line.str, "x2y1", "the flat string is unchanged, so nothing downstream shifts");
});

test("ordinary body text is never marked as a script", () => {
  const [line] = groupLines([it("plain text here", 50, 100, 60, BODY)], TOL, {});
  assert.deepEqual([...new Set(line.runs.map((r) => r.script))], [null]);
});

test("a line's baseline and face come from its body text, not a leading script", () => {
  // A script's font differs from the body face, and "not the body face" is half
  // of step 6's heading test — so a line opening with one could read as a
  // heading purely because of where its first run sat.
  const [line] = groupLines([
    { ...it("2", 50, 96.7, 3.5, 7), fontName: "script-font", pdfY: 703.3 },
    { ...it("x is the value", 54, 100, 60, BODY), fontName: "body-font", pdfY: 700 },
  ], TOL, {});
  assert.equal(line.fontName, "body-font");
  assert.equal(line.pdfY, 700);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
