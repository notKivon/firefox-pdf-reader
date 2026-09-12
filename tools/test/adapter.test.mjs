import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { outline } from "../../src/model/adapter.js";
import { ProviderError } from "../../src/model/errors.js";
import { completeSections } from "../../src/model/partial-json.js";
import { installFetch, goodAnswer, titlesFrom, rateLimited, sse, contentChunks } from "./stub.mjs";

const FIX = new URL("../../fixtures/", import.meta.url);
const fixturePath = (name) => new URL(`${name}.json`, FIX);
const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const resolveKey = async () => "test-key";

let passed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
  }
}

// ---------------------------------------------------------------- happy paths
await test("whole-document: one request, bullets aligned to the sent sections", async () => {
  const { sections } = fixture("bert");
  const calls = installFetch((body) => goodAnswer(body));
  const result = await outline({ sections, providerId: "gemini-prod", resolveKey, meta: { title: "BERT" } });

  assert.equal(calls.length, 1, "whole-document must be exactly one request");
  assert.equal(calls[0].model, "gemini-3.8-flash");
  assert.equal(result.sections.length, sections.length);
  assert.equal(result.strategy, "whole-document");
  assert.equal(result.usage.requests, 1);
  assert.equal(result.usage.promptTokens, 100);
  for (const [i, out] of result.sections.entries()) {
    assert.equal(out.title, sections[i].title);
    assert.equal(out.page, sections[i].page, `page for section ${i}`);
    assert.equal(out.y, sections[i].y, `y for section ${i}`);
  }
  assert.ok(result.tldr.length > 0);
});

await test("page/y come from extraction even when the model sends its own", async () => {
  const { sections } = fixture("resnet");
  installFetch((body) => ({
    sections: titlesFrom(body).map((title) => ({ title, bullets: ["a b", "c d"], page: 99, y: -1 })),
    tldr: "x",
  }));
  const result = await outline({ sections, providerId: "gemini-prod", resolveKey });
  assert.ok(!result.sections.some((s) => s.page === 99), "model-supplied page must be ignored");
  assert.equal(result.sections[0].page, sections[0].page);
});

await test("per-section: one request per section plus the TL;DR reduce", async () => {
  const { sections } = fixture("graphsage");
  const sendable = sections.filter((s) => s.text.trim());
  const calls = installFetch((body) =>
    body.response_format.json_schema.schema.properties.sections
      ? goodAnswer(body)
      : { tldr: "Reduced from the bullets." });
  const seen = [];
  const result = await outline({
    sections,
    providerId: "gemini-dev",
    resolveKey,
    onProgress: (p) => seen.push(p.sections.length),
  });
  assert.equal(calls.length, sendable.length + 1, "N section requests plus one reduce");
  assert.equal(calls.at(-1).body.response_format.json_schema.schema.properties.sections, undefined);
  assert.equal(result.usage.requests, sendable.length + 1);
  assert.equal(result.tldr, "Reduced from the bullets.");
  assert.ok(seen.length >= sendable.length, "progress fires as sections land");
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "progress is monotonic");
});

await test("empty-text sections are never sent and come back bullet-less in place", async () => {
  const sections = [
    { title: "1 Intro", page: 1, y: 700, text: "Some words here." },
    { title: "2 Method", page: 2, y: 600, text: "   " },
    { title: "2.1 Detail", page: 2, y: 500, text: "More words here." },
  ];
  const calls = installFetch((body) => goodAnswer(body));
  const result = await outline({ sections, providerId: "gemini-prod", resolveKey });
  const sent = titlesFrom(calls[0].body);
  assert.deepEqual(sent, ["1 Intro", "2.1 Detail"], "the empty section must not be in the payload");
  assert.equal(calls[0].body.response_format.json_schema.schema.properties.sections.minItems, 2);
  assert.equal(result.sections.length, 3, "it still occupies its index");
  assert.deepEqual(result.sections.map((s) => s.title), ["1 Intro", "2 Method", "2.1 Detail"]);
  assert.deepEqual(result.sections[1].bullets, []);
  assert.equal(result.sections[1].page, 2);
  assert.ok(result.sections[2].bullets.length >= 2);
});

// -------------------------------------------------------------- malformed in
const reject = async (name, reply, expect) => {
  await test(`malformed: ${name}`, async () => {
    const { sections } = fixture("vgg");
    installFetch(reply);
    await assert.rejects(
      () => outline({ sections, providerId: "gemini-prod", resolveKey }),
      (err) => {
        assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err}`);
        assert.equal(err.kind, "malformed", `kind was ${err.kind}: ${err.message}`);
        assert.match(err.message, expect);
        return true;
      },
    );
  });
};

await reject("a section dropped", (body) => {
  const answer = goodAnswer(body);
  answer.sections.splice(3, 1);
  return answer;
}, /sections for/);

await reject("a section added", (body) => {
  const answer = goodAnswer(body);
  answer.sections.splice(2, 0, { title: "Invented", bullets: ["a", "b"] });
  return answer;
}, /sections for/);

await reject("a section retitled", (body) => {
  const answer = goodAnswer(body);
  answer.sections[4].title = "Something Else Entirely";
  return answer;
}, /came back as/);

await reject("sections reordered", (body) => {
  const answer = goodAnswer(body);
  [answer.sections[1], answer.sections[2]] = [answer.sections[2], answer.sections[1]];
  return answer;
}, /came back as/);

await reject("not JSON at all", () => "Here is your outline:\n- it is good", /not valid JSON/);
await reject("empty response", () => new Response(new Blob(["data: [DONE]\n\n"]).stream(), { status: 200 }),
  /empty response/);
await reject("bullets missing", (body) => ({
  sections: titlesFrom(body).map((title) => ({ title })),
  tldr: "x",
}), /without a list of bullets/);

await test("a whitespace- or case-different echo is still accepted", async () => {
  const { sections } = fixture("vgg");
  installFetch((body) => ({
    sections: titlesFrom(body).map((title) => ({
      title: `  ${title.toUpperCase()}  `,
      bullets: ["a b", "c d"],
    })),
    tldr: "x",
  }));
  const result = await outline({ sections, providerId: "gemini-prod", resolveKey });
  assert.equal(result.sections[0].title, sections[0].title, "the extracted title is kept, not the echo");
});

// ----------------------------------------------------------------- fallback
await test("429 falls through to the next provider of the same destination", async () => {
  const { sections } = fixture("adam");
  const changes = [];
  const calls = installFetch((body) => (body.model === "gemini-3.8-flash" ? rateLimited() : goodAnswer(body)));
  const result = await outline({
    sections,
    providerId: "gemini-prod",
    resolveKey,
    onProviderChange: (id) => changes.push(id),
  });
  assert.equal(result.providerId, "gemini-dev");
  assert.equal(result.model, "gemini-3.5-flash-lite");
  assert.equal(result.strategy, "per-section", "the strategy is the serving provider's, not the first one's");
  assert.deepEqual(changes, ["gemini-dev"]);
  assert.ok(calls.every((c) => !c.url.includes("127.0.0.1")));
});

await test("an exhausted chain stops and never reaches another destination", async () => {
  const { sections } = fixture("adam");
  const calls = installFetch(() => rateLimited());
  await assert.rejects(
    () => outline({ sections, providerId: "gemini-prod", resolveKey }),
    (err) => {
      assert.equal(err.kind, "exhausted");
      assert.deepEqual(err.tried, ["gemini-prod", "gemini-dev"]);
      assert.deepEqual(err.otherDestinations, ["ollama"], "offered as a choice, never taken automatically");
      return true;
    },
  );
  assert.ok(calls.every((c) => !c.url.includes("127.0.0.1")), "the local model must never be called automatically");
  assert.ok(calls.every((c) => c.url.startsWith("https://generativelanguage.googleapis.com/")));
});

await test("an auth failure stops where it happens rather than falling back", async () => {
  const { sections } = fixture("adam");
  const calls = installFetch(() => new Response("bad key", { status: 401 }));
  await assert.rejects(
    () => outline({ sections, providerId: "gemini-prod", resolveKey }),
    (err) => err.kind === "auth",
  );
  assert.equal(calls.length, 1, "a bad key would fail identically on the next provider");
});

await test("a missing key never reaches the network", async () => {
  const { sections } = fixture("adam");
  const calls = installFetch(() => goodAnswer({}));
  await assert.rejects(
    () => outline({ sections, providerId: "gemini-prod", resolveKey: async () => null }),
    (err) => err.kind === "auth" && /settings/.test(err.message),
  );
  assert.equal(calls.length, 0);
});

await test("per-section isolates one malformed section and keeps the rest", async () => {
  const { sections } = fixture("vit");
  const sendable = sections.filter((s) => s.text.trim());
  installFetch((body, i) => {
    if (!body.response_format.json_schema.schema.properties.sections) return { tldr: "t" };
    return i === 2 ? "not json at all" : goodAnswer(body);
  });
  const result = await outline({ sections, providerId: "gemini-dev", resolveKey });
  const broken = result.sections.filter((s) => s.error);
  assert.equal(broken.length, 1, "exactly one section carries the failure");
  assert.ok(broken[0].bullets.length === 0);
  assert.ok(result.sections.filter((s) => s.bullets.length >= 2).length >= sendable.length - 2);
});

await test("per-section: every section malformed is a failure, not an empty outline", async () => {
  const { sections } = fixture("vit");
  installFetch((body) => (body.response_format.json_schema.schema.properties.sections ? "nope" : { tldr: "t" }));
  await assert.rejects(
    () => outline({ sections, providerId: "gemini-dev", resolveKey }),
    (err) => err.kind === "malformed",
  );
});

// ---------------------------------------------------------- progressive fill
await test("whole-document streams complete sections as they arrive", async () => {
  const sections = fixture("attention").sections.slice(0, 5);
  const answer = JSON.stringify(goodAnswer({
    messages: [{ content: sections.map((s) => `Title: ${s.title}`).join("\n") }],
    response_format: { json_schema: { schema: { properties: { tldr: {} } } } },
  }));
  installFetch(() => sse(contentChunks(answer, { pieces: 40 })));
  const seen = [];
  const result = await outline({
    sections,
    providerId: "gemini-prod",
    resolveKey,
    onProgress: (p) => seen.push(p.sections.map((s) => s.title)),
  });
  assert.ok(seen.length > 1, "the pane fills progressively, not all at the end");
  assert.deepEqual(seen.at(-1), result.sections.map((s) => s.title));
  assert.equal(seen[0][0], sections[0].title);
  assert.ok(seen[0].length < result.sections.length, "the first emission is partial");
  // Partial sections still carry a jump target taken from extraction.
  assert.ok(seen.every((titles) => titles.every((t, i) => t === sections[i].title)));
});

await test("the partial scanner never invents a section from a half-written one", () => {
  const text = '{"sections":[{"title":"A","bullets":["one two"]},{"title":"B","bull';
  const out = completeSections(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "A");
  assert.deepEqual(completeSections('{"sections":['), []);
  assert.deepEqual(completeSections('{"tldr":"nothing yet"'), []);
  // Braces and brackets inside a string must not close the object early.
  const tricky = '{"sections":[{"title":"A}{","bullets":["a \\" } b"]}]}';
  assert.equal(completeSections(tricky).length, 1);
  assert.equal(completeSections(tricky)[0].title, "A}{");
});

// ------------------------------------------------------------- every fixture
await test("every fixture outlines under both strategies", async () => {
  const names = readdirSync(FIX).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  assert.equal(names.length, 11);
  for (const name of names) {
    const { sections } = fixture(name);
    for (const providerId of ["gemini-prod", "gemini-dev"]) {
      installFetch((body) =>
        body.response_format.json_schema.schema.properties.sections ? goodAnswer(body) : { tldr: "t" });
      const result = await outline({ sections, providerId, resolveKey });
      assert.equal(result.sections.length, sections.length, `${name}/${providerId} section count`);
      for (const [i, s] of result.sections.entries()) {
        assert.equal(s.page, sections[i].page, `${name}/${providerId} page ${i}`);
        assert.equal(s.y, sections[i].y, `${name}/${providerId} y ${i}`);
      }
    }
  }
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
