// The extraction fixes of 2026-11-18, each as the shape that broke it: an IEEE
// paper whose left column ends right at the page's midline, IEEE headings in
// small capitals at body size, lettered subsections, numbered findings that are
// sentences rather than headings, and the text before the first heading.
import assert from "node:assert/strict";

const { isHeading } = await import("../../src/extract/sections.js");
const { buildSections } = await import("../../src/extract/assemble.js");
const { detectColumns, layoutPage } = await import("../../src/extract/columns.js");
globalThis.__layoutPage = { layoutPage };

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

const stats = { bodyHeight: 10, bodyFont: "body" };
const line = (str, fontName = "body", height = 10) => ({ str, fontName, height });

test("IEEE sections in small capitals of the body face are headings", () => {
  for (const str of ["I. INTRODUCTION", "II. RELATED WORK", "IV. RESULTS", "VI. CONCLUSION"]) {
    assert.ok(isHeading(line(str), stats), str);
  }
  assert.ok(!isHeading(line("I. Introduction of the method we use"), stats), "body face, not capitals: body text");
});

test("lettered subsections count when set apart, never in the body face", () => {
  assert.ok(isHeading(line("A. Key Findings", "italic"), stats));
  assert.ok(isHeading(line("D. Performance Summary", "italic"), stats));
  assert.ok(!isHeading(line("A. Smith showed that forests", "body"), stats));
});

test("numbered sentences and headings cut at a hyphen are not headings", () => {
  assert.ok(!isHeading(line("1. Feature-aware splitting improves early-stage ranking.", "italic"), stats));
  assert.ok(!isHeading(line("2. Not all enhancements are equally effective. The Kurtosis-", "italic"), stats));
  assert.ok(!isHeading(line("3. Unsupervised ranking has inherent limitations. The", "italic"), stats));
  assert.ok(isHeading(line("2.1 Unsupervised Feature-based Approaches", "bold", 12), stats), "an ordinary numbered heading still is one");
  assert.ok(isHeading(line("1) Limitations of Existing Detection:", "italic"), stats), "a run-in heading ends on a colon");
  assert.ok(isHeading(line("Abstract.", "bold"), stats), "the vocabulary still wins over the sentence rule");
});

test("the gutter is the gap between the columns, not the midpoint of their centres", () => {
  // Left column: full lines from x=49 to x=300 and short line-ends; right column
  // from x=312. The centres' midpoint falls at x≈299, inside the left column's
  // full lines — the IEEE page that read as one column.
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ x: 49, width: 251, str: "left full line" });
  for (let i = 0; i < 25; i++) items.push({ x: 49, width: 60, str: "end." });
  for (let i = 0; i < 45; i++) items.push({ x: 312, width: 251, str: "right full line" });
  const columns = detectColumns(items, 612);
  assert.equal(columns.count, 2);
  assert.ok(columns.boundary > 300 && columns.boundary < 312, `gutter at ${columns.boundary}`);
});

test("a full-width line made of several runs is not split at the gutter", () => {
  const { layoutPage } = globalThis.__layoutPage;
  const run = (str, x, width, y) => ({ str, x, width, y, height: 6.4, fontName: "f", pdfY: 800 - y });
  const items = [];
  // A two-column page: 12 rows per column, gutter between x=290 and x=307.
  for (let r = 0; r < 12; r++) {
    items.push(run(`left ${r}`, 38, 252, 300 + r * 8), run(`right ${r}`, 307, 251, 300 + r * 8));
  }
  // An abstract line across the gutter, in three runs that meet with word gaps.
  items.push(run("threshold and", 203, 47, 100), run("exponential", 254, 38, 100), run("and both symmetric versions", 296, 262, 100));
  const page = layoutPage({ pageNumber: 1, width: 595, items }, { bodyHeight: 6.4, columnCount: 2, boundaryRatio: 0.49 });
  const abstract = page.lines.find((l) => l.str.includes("exponential"));
  assert.equal(abstract.str, "threshold and exponential and both symmetric versions");
  assert.ok(page.lines.some((l) => l.str === "left 3") && page.lines.some((l) => l.str === "right 3"), "real columns still split");
});

test("the text before the first heading is kept as its own section", () => {
  const lines = [
    "Improving Early Detection of Radio Sources",
    "Pfunzo Thavhana Clement Nyirenda Michelle Lochner",
    "Abstract—The rapid growth of radio astronomical surveys has created a major challenge in identifying",
    "scientifically interesting sources from large populations of observed objects across many surveys.",
    "I. INTRODUCTION",
    "The Square Kilometre Array represents a paradigm shift.",
  ].map((str, i) => ({ str, page: 1, pdfY: 700 - i * 12, height: 10 }));
  const sections = buildSections([{ index: 4, line: lines[4], title: "I. INTRODUCTION" }], lines);
  assert.deepEqual(sections.map((s) => s.title), ["Title and abstract", "I. INTRODUCTION"]);
  assert.match(sections[0].text, /^Improving Early Detection/);
  assert.equal(sections[0].y, 700);
  const withAbstract = buildSections([{ index: 4, line: lines[4], title: "Abstract" }], lines);
  assert.equal(withAbstract[0].title, "Title and authors", "an abstract with its own heading is not claimed");
  const stamp = lines.slice(3).map((l, i) => (i === 0 ? { ...l, str: "arXiv:1234.5678" } : l));
  assert.equal(buildSections([{ index: 1, line: stamp[1], title: "I. INTRODUCTION" }], stamp)[0].title, "I. INTRODUCTION", "a stray stamp is not a title page");
});

console.log(results.join("\n"));
console.log(`\nextract-rules: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
