// Making a paper's math glyphs renderable — and, just as importantly, not
// touching anything else. The second half is what keeps this from quietly
// damaging the reported numbers CLAUDE.md requires results bullets to carry.
import assert from "node:assert/strict";

const { normalizeText, UNRENDERABLE } = await import("../../src/extract/normalize.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

test("math italic letters become the plain letters they are a styling of", () => {
  assert.equal(normalizeText("\u{1D44E}, \u{1D44F}"), "a, b");
  assert.equal(normalizeText("\u{1D708}"), "ν", "italic nu is Greek nu");
  assert.equal(normalizeText("\u{1D400}\u{1D401}"), "AB", "bold capitals too");
  assert.equal(normalizeText("\u{1D7CE}\u{1D7D7}"), "09", "and the mathematical digits");
  // The math italic alphabet has no `h`; Unicode points it at PLANCK CONSTANT.
  assert.equal(normalizeText("ℎ"), "h");
});

test("a real sentence out of a paper survives intact", () => {
  assert.equal(
    normalizeText("Adam converges at O(1/\u{1D6FD}√T) for \u{1D44E} ∈ [0, 1)."),
    "Adam converges at O(1/β√T) for a ∈ [0, 1).",
  );
});

test("everything a results bullet needs is left alone", () => {
  // Blanket NFKC would flatten every one of these, which is why it is not used.
  for (const s of ["10⁻⁸", "½", "x² + y²", "94.5% ± 0.3", "β1 = 0.9"]) {
    assert.equal(normalizeText(s), s, s);
  }
  // Double-struck letters are the reals and the naturals, not styled R and N.
  assert.equal(normalizeText("ℝⁿ and ℕ"), "ℝⁿ and ℕ");
});

test("plain text and empty input are untouched", () => {
  assert.equal(normalizeText("3.1 Residual Learning"), "3.1 Residual Learning");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(undefined), undefined);
});

test("repeated calls give the same answer", () => {
  // A global regex kept across calls carries `lastIndex` with it; a `test()`
  // guard in front of the replace would make the second call skip the start of
  // the string. This runs on every extracted run, so it must be stateless.
  const input = "\u{1D44E} and \u{1D44F}";
  assert.equal(normalizeText(input), "a and b");
  assert.equal(normalizeText(input), "a and b");
  assert.equal(normalizeText(normalizeText(input)), "a and b", "and it is idempotent");
});

test("stacked bracket pieces become the bracket they are part of", () => {
  // A square bracket taller than a line arrives as two private-use fragments,
  // one per line. Confirmed in the fixtures: U+F8EE then U+F8F0.
  assert.equal(normalizeText("\uF8EE x"), "[ x");
  assert.equal(normalizeText("\uF8F0 y"), "[ y");
  assert.equal(normalizeText("z \uF8FB"), "z ]");
  assert.equal(normalizeText("\uF8EB a \uF8F8"), "( a )");
  assert.equal(normalizeText("\uF8F1 b \uF8FE"), "{ b }");
});

test("private use characters that are not delimiters are left alone", () => {
  // They mean pdf.js could not map a font's glyphs at all. Substituting a guess
  // would put text in the pane that the paper does not contain; the extraction
  // panel names them instead.
  assert.equal(normalizeText("\uE042"), "\uE042");
  assert.equal(normalizeText("\uF8E5"), "\uF8E5", "the radical extender has no honest equivalent");
  assert.match(normalizeText("\uE042"), UNRENDERABLE, "and it is reported");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
