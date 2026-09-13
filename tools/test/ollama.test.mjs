// Step 12: the local model behind the same adapter.
//
// What is worth pinning here is everything the OpenAI-compatible path does NOT
// establish — a different endpoint, a different wire format, a different way of
// carrying the schema and the token counts, and two failures (a refused origin,
// a section that will not fit the context) that only a local model has. The
// adapter itself is unchanged and must stay that way: it calls `chatJson` and
// never learns which wire answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outline } from "../../src/model/adapter.js";
import { chatJson } from "../../src/model/transport.js";
import { getProvider } from "../../src/model/providers.js";
import { goodAnswer, installFetch, ndjson, nativeChunks } from "./stub.mjs";
import { installIndexedDb } from "./idb.mjs";

installIndexedDb();

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), "utf8"));
const resolveKey = async () => {
  throw new Error("the local model must never ask for a key");
};

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

// ------------------------------------------------------------------ the wire
await test("the local model is spoken to over /api/chat, with num_ctx and no key", async () => {
  const { sections } = fixture("attention");
  const calls = installFetch((body) => goodAnswer(body));
  await outline({ sections, providerId: "ollama", resolveKey, meta: { title: "Attention" } });

  assert.ok(calls.length > 1, "per-section: a request each, plus the TL;DR");
  for (const call of calls) {
    assert.equal(call.url, "http://127.0.0.1:11434/api/chat", "the native endpoint, not /v1/");
    assert.equal(call.model, "gemma4:e4b");
    // The whole reason this transport exists: the OpenAI layer drops `options`,
    // so num_ctx never arrived and the model loaded at 4096 and truncated in
    // silence. If this assertion ever goes green against /v1/, re-measure.
    assert.equal(call.body.options.num_ctx, 32768, "the context window must reach the server");
    assert.equal(call.body.think, false, "the bullets are the answer; the thinking is not");
    assert.equal(call.body.stream, true);
    assert.equal(call.headers.Authorization, undefined, "a local model is sent no key");
  }
});

await test("the schema travels as `format`, and is the same schema either way", async () => {
  const { sections } = fixture("attention");
  const calls = installFetch((body) => goodAnswer(body));
  await outline({ sections, providerId: "ollama", resolveKey });

  const [first] = calls;
  assert.equal(first.body.response_format, undefined, "no OpenAI wrapper on the native wire");
  assert.equal(first.body.format.properties.sections.minItems, 1, "one section per request");
  assert.equal(first.body.format.properties.sections.items.properties.bullets.minItems, 2);
  assert.equal(first.body.format.properties.sections.items.properties.bullets.maxItems, 4);
});

await test("NDJSON token counts reach the adapter's totals, cached prompt included", async () => {
  const provider = getProvider("ollama");
  installFetch(() =>
    ndjson([
      { message: { content: '{"tldr":' }, done: false },
      { message: { content: '"it works."}' }, done: false },
      { message: { content: "" }, done: true, prompt_eval_count: 40, prompt_eval_cached_count: 60, eval_count: 12 },
    ]),
  );
  const { data, usage } = await chatJson({
    providerId: "ollama",
    provider,
    messages: [{ role: "user", content: "hi" }],
    schema: { type: "object" },
  });
  assert.equal(data.tldr, "it works.", "deltas across lines assemble into one body");
  assert.equal(usage.prompt_tokens, 100, "cached tokens were still in the text that was sent");
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 112);
});

await test("progressive fill works over NDJSON, not just SSE", async () => {
  const body = '{"sections":[{"title":"A","bullets":["one","two"]},{"title":"B","bullets":["three","four"]}]}';
  installFetch(() => ndjson(nativeChunks(body, { pieces: 20, usage: { prompt_tokens: 1, completion_tokens: 1 } })));
  const seen = [];
  await chatJson({
    providerId: "ollama",
    provider: getProvider("ollama"),
    messages: [{ role: "user", content: "hi" }],
    schema: { type: "object" },
    onPartial: (sections) => seen.push(sections.length),
  });
  assert.deepEqual(seen, [1, 2], "each section is emitted as it closes, not all at the end");
});

// --------------------------------------------------------------- the failures
await test("a refused origin names the remedy for the app the user actually runs", async () => {
  const { sections } = fixture("attention");
  installFetch(() => new Response("Forbidden", { status: 403 }));
  const err = await outline({ sections, providerId: "ollama", resolveKey }).catch((e) => e);

  assert.equal(err.kind, "origin-refused");
  // PROGRESS.md 2026-09-13: the desktop app is started by launchd and never
  // sees a shell, so the terminal form alone is the wrong remedy. Both, or the
  // message is worse than a generic error.
  assert.ok(/launchctl setenv OLLAMA_ORIGINS/.test(err.message), "the desktop-app remedy");
  assert.ok(/ollama serve/.test(err.message), "the terminal remedy");
  assert.ok(/not.*CORS/i.test(err.message), "says what it is not, so no one goes hunting permissions");
  assert.ok(/reboot/.test(err.message), "it comes back after a reboot; say so once");
});

await test("a model that was never pulled says so, with the command", async () => {
  const { sections } = fixture("attention");
  installFetch(() => new Response("model not found", { status: 404 }));
  const err = await outline({ sections, providerId: "ollama", resolveKey }).catch((e) => e);
  assert.ok(/ollama pull gemma4:e4b/.test(err.message), err.message);
});

await test("a section too large for the context is refused before it is sent", async () => {
  const calls = installFetch((body) => goodAnswer(body));
  const huge = { title: "1 BIG", page: 1, y: 700, text: "word ".repeat(40_000) };
  const err = await outline({ sections: [huge], providerId: "ollama", resolveKey }).catch((e) => e);

  assert.equal(err.kind, "too-large");
  assert.equal(calls.length, 0, "truncation is silent, so nothing may be sent to find out");
  assert.ok(/32,768-token context/.test(err.message), err.message);
});

await test("an over-large section costs that section, never the whole paper", async () => {
  const { sections } = fixture("attention");
  const withHuge = [...sections.slice(0, 4), { title: "X BIG", page: 9, y: 700, text: "word ".repeat(40_000) }];
  installFetch((body) => goodAnswer(body));
  const result = await outline({ sections: withHuge, providerId: "ollama", resolveKey });

  const big = result.sections.find((s) => s.title === "X BIG");
  assert.ok(big.error, "the section that could not be sent says so");
  assert.deepEqual(big.bullets, []);
  assert.equal(big.page, 9, "and still jumps to the right place");
  const rest = result.sections.filter((s) => s.title !== "X BIG" && s.bullets.length);
  assert.ok(rest.length >= 3, "the sections that did fit are outlined");
});

await test("nothing about Gemini changed: it still speaks the OpenAI wire", async () => {
  const { sections } = fixture("attention");
  const calls = installFetch((body) => goodAnswer(body));
  await outline({ sections, providerId: "gemini-prod", resolveKey: async () => "test-key" });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v1beta/openai/chat/completions"), calls[0].url);
  assert.equal(calls[0].body.format, undefined, "no native field leaked onto the OpenAI path");
  assert.ok(calls[0].body.response_format.json_schema.strict);
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
