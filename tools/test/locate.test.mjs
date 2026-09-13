// Locating a bullet in the paper it was written from.
//
// The reason this is tested against real papers rather than a fixed string: the
// feature's whole claim is that a bullet's position can be DERIVED, so that no
// model ever has to be asked for it (CLAUDE.md). A matcher that works on a
// hand-made example and not on a real section would not support that claim.
//
// Ground truth is built rather than judged. A passage is taken from a real
// fixture at a known line, then degraded the way a model degrades it — a subset
// of its words, reordered, wrapped in phrasing of its own — and the matcher has
// to find its way back to the line it came from. That makes "did it land in the
// right place" a fact rather than an opinion.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { locateBullet } from "../../src/viewer/locate.js";

const FIX = new URL("../../fixtures/", import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), "utf8"));
const names = readdirSync(FIX).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

// Fixtures are assembled sections and keep no line breaks, so they are re-broken
// here at a typical two-column measure. The matcher only ever sees line strings
// and positions, so where the breaks fall changes nothing about what is tested.
function toLines(text, { page = 3, width = 88 } = {}) {
  const lines = [];
  let y = 700;
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + word.length + 1 > width) {
      lines.push({ page, y, height: 9.5, str: current });
      y -= 11.5;
      if (y < 60) { y = 700; page++; }
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push({ page, y, height: 9.5, str: current });
  return lines;
}

// How a model restates a passage: most of the content words, some dropped, in a
// different order, inside a sentence of its own.
function paraphrase(passage, seed) {
  const words = passage.split(/\s+/).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "").length > 3);
  const kept = words.filter((_, i) => (i + seed) % 3 !== 0).slice(0, 12);
  return `The section reports that ${kept.reverse().join(" ")}.`;
}

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

test("a paraphrase of a passage lands on the lines it came from", () => {
  let tried = 0;
  let hit = 0;
  const misses = [];
  for (const name of names) {
    for (const section of fixture(name).sections) {
      if (section.text.length < 1200) continue;
      const lines = toLines(section.text);
      // Three probes per section, spread through it — the start, the middle and
      // the end, because a matcher biased to the opening would still score well
      // on one probe per section.
      for (const at of [0.15, 0.5, 0.8]) {
        const index = Math.floor(lines.length * at);
        const passage = lines.slice(index, index + 2).map((l) => l.str).join(" ");
        const found = locateBullet(paraphrase(passage, index), lines);
        tried++;
        // Landing within a line of the source is right: the passage spans two
        // lines and a window may legitimately start on either.
        const target = lines[index];
        if (found && found.page === target.page && Math.abs(found.y - target.y) <= 12) hit++;
        else misses.push(`${name}/${section.title}@${at}`);
      }
    }
  }
  assert.ok(tried >= 100, `enough real passages to mean something (got ${tried})`);
  const rate = hit / tried;
  results.push(`      located ${hit}/${tried} paraphrased passages (${(rate * 100).toFixed(1)}%)`);
  assert.ok(rate > 0.9, `should find most passages, found ${(rate * 100).toFixed(1)}% — misses: ${misses.slice(0, 5)}`);
});

test("a bullet about nothing in the section is not placed at all", () => {
  const { sections } = fixture("attention");
  const lines = toLines(sections.find((s) => s.text.length > 1500).text);
  // Fluent, plausible, and about a different paper entirely. The honest answer
  // is null, and the caller falls back to the heading.
  const foreign = "Participants completed a questionnaire measuring dietary sodium intake across twelve rural clinics.";
  assert.equal(locateBullet(foreign, lines), null);
});

// Recall alone is worthless here and the first version proved it: scoring only
// over the words a section happens to contain gave 99% recall AND placed three
// foreign bullets in four, because one incidental shared word is a perfect score
// when it is the only word counted. Precision is measured over passages lifted
// from OTHER papers, which must not find a home in this one.
test("a passage from another paper is almost never placed in this one", () => {
  const pool = [];
  for (const name of names) {
    for (const section of fixture(name).sections) {
      if (section.text.length > 1200) pool.push({ name, section });
    }
  }
  let foreign = 0;
  let placed = 0;
  for (let i = 0; i < pool.length; i++) {
    const lines = toLines(pool[i].section.text);
    for (let step = 1; step <= 3; step++) {
      const other = pool[(i + step * 7) % pool.length];
      if (other.name === pool[i].name) continue;
      const otherLines = toLines(other.section.text);
      const at = Math.floor(otherLines.length * 0.4);
      const bullet = paraphrase(otherLines.slice(at, at + 2).map((l) => l.str).join(" "), at);
      foreign++;
      if (locateBullet(bullet, lines)) placed++;
    }
  }
  assert.ok(foreign >= 100, `enough foreign passages to mean something (got ${foreign})`);
  const rate = placed / foreign;
  results.push(`      placed ${placed}/${foreign} foreign passages (${(rate * 100).toFixed(1)}%) — lower is better`);
  assert.ok(rate < 0.05, `foreign passages should almost never place, ${(rate * 100).toFixed(1)}% did`);
});

test("no lines, no bullet, no text: null rather than a guess", () => {
  assert.equal(locateBullet("anything at all", []), null);
  assert.equal(locateBullet("anything at all", undefined), null);
  assert.equal(locateBullet("", toLines("some words here and there")), null);
  assert.equal(locateBullet("the and of to is", toLines("some words here")), null, "stopwords locate nothing");
});

test("a located span never leaves its own section", () => {
  const { sections } = fixture("bert");
  for (const section of sections.filter((s) => s.text.length > 900)) {
    const lines = toLines(section.text);
    const pages = new Set(lines.map((l) => l.page));
    const ys = lines.map((l) => l.y);
    for (const at of [0.2, 0.6]) {
      const index = Math.floor(lines.length * at);
      const found = locateBullet(paraphrase(lines.slice(index, index + 2).map((l) => l.str).join(" "), index), lines);
      if (!found) continue;
      // The search space IS the section, so a bad match is off by lines rather
      // than by chapters — which is what makes deriving this safe at all.
      assert.ok(pages.has(found.page), "page belongs to the section");
      assert.ok(found.y <= Math.max(...ys) && found.y >= Math.min(...ys), "y is inside the section");
      assert.ok(found.yEnd <= found.y, "+y is up: the span ends at or below where it starts");
    }
  }
});

test("a span that would cross a page break is reported on the page it starts on", () => {
  const lines = [
    { page: 4, y: 90, height: 9.5, str: "gradient descent converges under the stated smoothness assumption" },
    { page: 4, y: 78, height: 9.5, str: "with step size decaying proportionally to the iteration count" },
    { page: 5, y: 700, height: 9.5, str: "and the regret bound follows immediately from the preceding lemma" },
  ];
  const found = locateBullet("Convergence holds with decaying step size and the regret bound follows.", lines);
  assert.ok(found);
  assert.equal(found.page, 4);
  assert.equal(found.yEnd, 78, "clipped to the last line on the starting page");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.filter((r) => r.startsWith("  ok") || r.startsWith("FAIL")).length} passed`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
