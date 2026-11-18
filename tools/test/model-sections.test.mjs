import "./test-providers.mjs";
// Sections chosen by the model, placed by this machine (2026-11-18): the model
// copies each section's opening line; extract/anchor.js finds it in the paper,
// and every page and y comes from the line found — never from the model.
import assert from "node:assert/strict";
import { installIndexedDb } from "./idb.mjs";
import { installFetch } from "./stub.mjs";

installIndexedDb();
globalThis.browser = {
  storage: { local: { get: async (k) => ({ [k]: { gemini: "g", "claude-bridge": "srb_t" }[k] ?? undefined }) } },
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
};

const { anchorSections, bodiesOf, paperText } = await import("../../src/extract/anchor.js");
const { outline } = await import("../../src/model/adapter.js");
const { plan } = await import("../../src/background/plan.js");
const { resolvedSections } = await import("../../src/viewer/outline-sections.js");

// A two-page paper as extraction hands it over: lines in reading order.
const paper = [
  ["Improving Early Detection of Radio Sources", 1, 700],
  ["Abstract—We rank sources with isolation forests.", 1, 640],
  ["I. INTRODUCTION", 1, 600],
  ["Surveys are large. 1. This is a list item, not a heading.", 1, 590],
  ["A. The Data Deluge in Modern Radio", 1, 560],
  ["Astronomy", 1, 548],
  ["MeerKAT generates terabytes per hour.", 1, 536],
  ["1) Limitations of Existing Detection: Existing frame-", 2, 700],
  ["works depend on features.", 2, 688],
  ["IV. RESULTS", 2, 600],
  ["Pooled Gain reaches P@10 = 0.600.", 2, 588],
].map(([str, page, y]) => ({ str, page, y }));

const answer = (sections) => ({ sections, tldr: "It ranks radio sources." });
const reply = (data) =>
  installFetch(() => JSON.stringify(data));
const SECTIONS = [
  { heading: "Improving Early Detection of Radio Sources", title: "Title and abstract", bullets: ["Ranks sources."] },
  { heading: "I. INTRODUCTION", title: "I. Introduction", bullets: ["Surveys are large."] },
  { heading: "A. The Data Deluge in Modern Radio Astronomy", title: "A. The Data Deluge", bullets: ["Terabytes."] },
  { heading: "1) Limitations of Existing Detection:", title: "Limitations", bullets: ["Features matter."] },
  { heading: "IV. RESULTS", title: "IV. Results", bullets: ["P@10 = 0.600."] },
];

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

await test("headings are found in order, wrapped and run-in ones included", () => {
  const { sections, missing } = anchorSections(SECTIONS, paper);
  assert.equal(missing, null);
  assert.deepEqual(sections.map((s) => [s.start, s.page, s.y]), [[0, 1, 700], [2, 1, 600], [4, 1, 560], [7, 2, 700], [9, 2, 600]]);
  const bodies = bodiesOf(sections, paper);
  assert.equal(bodies[2].text, "MeerKAT generates terabytes per hour.", "the wrapped heading's second line is not body");
  assert.equal(bodies[3].text, "Existing frameworks depend on features.", "a run-in heading keeps its text, hyphen rejoined");
});

await test("a heading not in the paper, or out of order, is missing — never guessed", () => {
  assert.equal(anchorSections([{ heading: "II. METHODS" }], paper).missing, "II. METHODS");
  const backwards = anchorSections([SECTIONS[4], SECTIONS[1]], paper);
  assert.equal(backwards.missing, "I. INTRODUCTION", "searching only forward keeps the paper's order");
  assert.equal(anchorSections([{ heading: "Surveys" }], paper).sections[0].start, 3, "a line's start, not its middle");
  assert.equal(anchorSections([{ heading: "list item" }], paper).missing, "list item");
});

await test("the paper is sent as lines with page markers and no line numbers", () => {
  const text = paperText(paper);
  assert.match(text, /^\[page 1\]\nImproving Early Detection/);
  assert.match(text, /\n\[page 2\]\n1\) Limitations/);
  assert.doesNotMatch(text, /^\d+[:\t]/m, "a number would be an offset, and asking for one is forbidden");
});

await test("Opus is sent the whole paper and its sections land on the paper's own lines", async () => {
  const calls = reply(answer(SECTIONS));
  const progress = [];
  const result = await outline({
    sections: [{ title: "x", text: "some text", page: 1, y: 0 }],
    paper,
    providerId: "claude-opus",
    resolveKey: async () => "srb_t",
    meta: { title: "Radio" },
    onProgress: (p) => progress.push(p.sections.length),
  });
  assert.equal(calls.length, 1);
  const user = calls[0].body.messages.at(-1).content;
  assert.match(user, /\[page 2\]\n1\) Limitations[^]*\nIV\. RESULTS\n/);
  assert.equal(calls[0].body.response_format.json_schema.schema.properties.sections.maxItems, 40);
  assert.deepEqual(result.sections.map((s) => [s.title, s.page, s.y]), [
    ["Title and abstract", 1, 700], ["I. Introduction", 1, 600], ["A. The Data Deluge", 1, 560], ["Limitations", 2, 700], ["IV. Results", 2, 600],
  ]);
  assert.equal(result.sections[3].heading, "1) Limitations of Existing Detection:");
  assert.ok(progress.length > 0 && progress.at(-1) <= 5, "the pane fills as sections are placed");
});

await test("a made-up heading fails the outline and nothing comes back to cache", async () => {
  reply(answer([...SECTIONS.slice(0, 2), { heading: "II. RELATED WORK", title: "Related", bullets: ["x"] }]));
  await assert.rejects(
    outline({ sections: [{ title: "x", text: "t", page: 1, y: 0 }], paper, providerId: "claude-opus", resolveKey: async () => "k" }),
    (err) => err.kind === "malformed" && /II\. RELATED WORK/.test(err.message),
  );
});

await test("the local model still gets the extracted sections", async () => {
  const calls = installFetch((body) => ({
    sections: [{ title: body.messages.at(-1).content.match(/Title: (.+)/)[1], bullets: ["a", "b"] }],
  }));
  await outline({
    sections: [{ title: "1 Intro", text: "words", page: 1, y: 0 }],
    paper,
    providerId: "ollama",
    resolveKey: async () => null,
  }).catch(() => {});
  assert.ok(calls.length >= 1);
  assert.doesNotMatch(calls[0].body.messages.at(-1).content, /\[page 1\]/);
});

await test("the card's plan counts the whole paper and claims no section count", async () => {
  const detail = await plan({ hash: "d".repeat(64), sections: [{ title: "x", text: "t", page: 1, y: 0 }], paper, providerId: "claude-opus" });
  assert.equal(detail.modelSections, true);
  assert.equal(detail.sectionCount, null);
  assert.ok(detail.estTokens > 50);
  const local = await plan({ hash: "d".repeat(64), sections: [{ title: "x", text: "t", page: 1, y: 0 }], paper, providerId: "ollama" });
  assert.equal(local.modelSections, false);
  assert.equal(local.sectionCount, 1);
});

await test("the viewer finds a cached outline's lines again, or none at all", () => {
  const cached = { sections: SECTIONS.map((s, i) => ({ ...s, page: 9, y: 9 + i })) };
  const resolved = resolvedSections(cached, { paper });
  assert.equal(resolved.length, 5);
  assert.equal(resolved[4].lines[0].str, "Pooled Gain reaches P@10 = 0.600.");
  assert.equal(resolvedSections(cached, { paper: paper.slice(0, 5) }), null, "an outline that no longer fits gets no line placement");
  const extracted = [{ title: "1 Intro", lines: [{ str: "x" }] }];
  assert.equal(resolvedSections({ sections: [{ title: "1 Intro", bullets: [] }] }, { sections: extracted }), extracted);
});

console.log(results.join("\n"));
console.log(`\nmodel-sections: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
