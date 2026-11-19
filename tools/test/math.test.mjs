// Equations in model output (2026-11-19): which spans are math, how a mangled
// backslash is repaired, and that KaTeX is held to its safe settings.
import assert from "node:assert/strict";
import katex from "katex";
import { FakeNode } from "./dom.mjs";

const { mathParts, mathNode, repairTex, withMath } = await import("../../src/viewer/math.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

const kinds = (text) => mathParts(text).map((p) => (p.tex === undefined ? ["t", p.text] : [p.display ? "D" : "m", p.tex]));

test("inline and displayed math are found, in all four delimiters", () => {
  assert.deepEqual(kinds("Error $\\epsilon < 10^{-5}$ at $N = 129^3$."), [
    ["t", "Error "], ["m", "\\epsilon < 10^{-5}"], ["t", " at "], ["m", "N = 129^3"], ["t", "."],
  ]);
  assert.deepEqual(kinds("so $$\\rho(x) = \\sum_i m_i W(x - x_i, h_i)$$ holds"), [
    ["t", "so "], ["D", "\\rho(x) = \\sum_i m_i W(x - x_i, h_i)"], ["t", " holds"],
  ]);
  assert.deepEqual(kinds("\\(a^2\\) and \\[b^2\\]"), [["m", "a^2"], ["t", " and "], ["D", "b^2"]]);
});

test("prices, lone dollars and escaped dollars stay text", () => {
  assert.deepEqual(kinds("It costs $5 and $10 per run."), [["t", "It costs $5 and $10 per run."]]);
  assert.deepEqual(kinds("A $ sign alone"), [["t", "A $ sign alone"]]);
  assert.deepEqual(kinds("Pay \\$3 now"), [["t", "Pay $3 now"]]);
  assert.deepEqual(kinds("$ x $ has spaces inside"), [["t", "$ x $ has spaces inside"]]);
});

test("a backslash eaten as a JSON escape is put back before a letter only", () => {
  assert.equal(repairTex("$\beta$ and \frac{1}{2} and \theta"), "$\\beta$ and \\frac{1}{2} and \\theta");
  assert.equal(repairTex("a\tb"), "a\\tb");
  assert.equal(repairTex("col\t1"), "col\t1", "a tab before a digit is a real tab");
  assert.equal(repairTex("line\nnext"), "line\nnext", "newlines are never touched");
});

test("KaTeX renders real TeX and refuses links and HTML", () => {
  assert.match(katex.renderToString("\\frac{a}{b}", { throwOnError: true, trust: false }), /mfrac|frac-line/);
  const blocked = katex.renderToString("\\href{javascript:alert(1)}{x}", { throwOnError: false, trust: false });
  assert.doesNotMatch(blocked, /href="javascript/);
  const html = katex.renderToString("\\htmlClass{evil}{x}", { throwOnError: false, trust: false, strict: "ignore" });
  assert.doesNotMatch(html, /class="evil"/);
});

test("TeX that cannot be typeset is shown as the model wrote it", () => {
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  const node = mathNode({ tex: "\\frac{1}{", display: false, source: "$\\frac{1}{$" });
  assert.equal(node.className, "math math-raw");
  assert.equal(node.textContent, "$\\frac{1}{$");
  const nodes = withMath("plain words only", (t) => ({ text: t }));
  assert.deepEqual(nodes, [{ text: "plain words only" }]);
});

console.log(results.join("\n"));
console.log(`\nmath: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
