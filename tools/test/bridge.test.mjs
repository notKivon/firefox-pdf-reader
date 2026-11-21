import "./test-providers.mjs";
// The Claude bridge (tools/bridge/): who may use it, what it runs, and that its
// stream reads back through the extension's own transport unchanged.
//
// A fake `claude` (fake-claude.mjs) stands in for the CLI, so this makes no
// model call and spends no subscription usage.
import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fake = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
chmodSync(fake, 0o755);
process.env.CLAUDE_BIN = fake;
process.env.ANTHROPIC_API_KEY = "must-never-reach-the-cli";
const argvFile = join(tmpdir(), `fake-claude-argv-${process.pid}.json`);
process.env.FAKE_CLAUDE_ARGV = argvFile;

const { createBridge } = await import("../bridge/server.mjs");
const { chatJson } = await import("../../src/model/openai-compat.js");
const { PROVIDERS } = await import("../../src/model/providers.js");
const { outlineSchema } = await import("../../src/model/prompts.js");

const token = "srb_test";
const server = createBridge({ token, log: () => {} });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1/`;
const provider = { ...PROVIDERS["claude-opus"], baseUrl: base };

// The browser sets Origin itself; Node's fetch does not.
const realFetch = globalThis.fetch;
let origin = "moz-extension://abc";
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(origin ? { Origin: origin } : {}) } });

const answer = { sections: [{ title: "1 Introduction", bullets: ["Adam is an optimiser."] }], tldr: "Adam." };
process.env.FAKE_CLAUDE_ANSWER = JSON.stringify(answer);
const messages = [
  { role: "system", content: "SYSTEM TEXT" },
  { role: "user", content: "THE PAPER" },
];
const ask = (opts = {}) =>
  chatJson({ providerId: "claude-opus", provider, apiKey: token, messages, schema: outlineSchema(1), ...opts });

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
  process.env.FAKE_CLAUDE_MODE = "ok";
  origin = "moz-extension://abc";
}

await test("a run streams back through openai-compat and decodes", async () => {
  const partials = [];
  let alive = 0;
  const result = await ask({ onPartial: (s) => partials.push(s.length), onAlive: () => alive++ });
  assert.deepEqual(result.data, answer);
  assert.equal(result.usage.prompt_tokens, 110, "cache tokens count as input");
  assert.equal(result.usage.completion_tokens, 50);
  assert.ok(alive > 0, "every line is a sign of life for the watchdog");
  assert.deepEqual(partials, [1], "sections fill in as the JSON streams");
});

await test("the CLI is stripped down and can only bill the subscription", async () => {
  await ask();
  const { argv, stdin, env } = JSON.parse(readFileSync(argvFile, "utf8"));
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(flag("--model"), "claude-opus-5-5");
  assert.equal(flag("--system-prompt"), "SYSTEM TEXT");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--setting-sources"), "");
  assert.ok(argv.includes("--strict-mcp-config") && argv.includes("--no-session-persistence"));
  assert.deepEqual(JSON.parse(flag("--json-schema")), outlineSchema(1));
  assert.equal(stdin, "THE PAPER", "the paper goes on stdin, not argv");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "an API key in the environment never reaches the CLI");
});

await test("a page's origin is refused", async () => {
  origin = "https://evil.example";
  await assert.rejects(ask(), (err) => err.status === 403);
});

await test("a wrong token is refused as an auth failure", async () => {
  await assert.rejects(ask({ apiKey: "srb_wrong" }), (err) => err.kind === "auth" && err.status === 401);
});

await test("only the three Claude models run", async () => {
  await assert.rejects(ask({ provider: { ...provider, model: "claude-opus-5-5 --tools Bash" } }), (err) => err.status === 400);
});

await test("a usage limit is a 429 with a reset time, so fallback and the pane can act", async () => {
  process.env.FAKE_CLAUDE_MODE = "limit";
  await assert.rejects(ask(), (err) => {
    assert.equal(err.kind, "rate-limit");
    assert.ok(err.retryAfterMs > 3_500_000 && err.retryAfterMs <= 3_600_000, `retryAfterMs ${err.retryAfterMs}`);
    assert.match(err.message, /usage limit/);
    return true;
  });
});

await test("a CLI failure says what Claude Code said", async () => {
  process.env.FAKE_CLAUDE_MODE = "error";
  await assert.rejects(ask(), (err) => err.status === 502 && /selected model/.test(err.message));
});

await test("an answer started over is replaced by the final one, not concatenated", async () => {
  process.env.FAKE_CLAUDE_MODE = "retry";
  const result = await ask();
  assert.deepEqual(result.data, answer);
});

await test("Opus and Sonnet get guidelines; Haiku and the rest keep the strict rules", async () => {
  const { wholeDocumentMessages } = await import("../../src/model/prompts.js");
  const sections = [{ title: "1 Intro", text: "Some text.", page: 1, y: 0 }];
  for (const id of ["claude-opus", "claude-sonnet"]) {
    const style = PROVIDERS[id].promptStyle;
    const [sys] = wholeDocumentMessages(sections, {}, style);
    assert.match(sys.content, /Use your judgement/, id);
    assert.doesNotMatch(sys.content, /2 to 4 bullets|20 words/, id);
    assert.match(sys.content, /echo each section's Title field back exactly/i, "the checksum line stays");
    const bullets = outlineSchema(1, { style }).properties.sections.items.properties.bullets;
    assert.equal(bullets.maxItems, undefined, id);
  }
  for (const id of ["claude-haiku", "gemini-prod", "ollama"]) {
    const [sys] = wholeDocumentMessages(sections, {}, PROVIDERS[id].promptStyle);
    assert.match(sys.content, /2 to 4 bullets/, id);
    assert.equal(outlineSchema(1, { style: PROVIDERS[id].promptStyle }).properties.sections.items.properties.bullets.maxItems, 4);
  }
});

await test("a chat turn runs without a schema and carries the earlier turns", async () => {
  const { chatText } = await import("../../src/model/openai-compat.js");
  process.env.FAKE_CLAUDE_TEXT = "Adam corrects bias [§ 3 Bias].";
  const seen = [];
  const result = await chatText({
    providerId: "claude-opus",
    provider,
    apiKey: token,
    messages: [
      { role: "system", content: "THE PAPER" },
      { role: "user", content: "First?" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second?" },
    ],
    onText: (text) => seen.push(text),
  });
  assert.equal(result.text, "Adam corrects bias [§ 3 Bias].");
  assert.equal(seen.at(-1), result.text);
  assert.ok(seen.length >= 2, "streamed, not delivered at the end");
  const { argv, stdin } = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.ok(!argv.includes("--json-schema"));
  assert.equal(argv[argv.indexOf("--system-prompt") + 1], "THE PAPER");
  assert.match(stdin, /Reader: First\?\n\nYou: First answer\./);
  assert.match(stdin, /The reader's new message:\n\nSecond\?$/);
});

// Measured on the real CLI 2026-11-21: a text reply is whole ~2.5 s before the
// process exits, a structured one ~0.8 s. The bridge answers at the answer.
await test("a chat reply returns when it is whole, not when Claude Code exits", async () => {
  const { chatText } = await import("../../src/model/openai-compat.js");
  process.env.FAKE_CLAUDE_TEXT = "Done early.";
  process.env.FAKE_CLAUDE_TAIL_MS = "3000";
  try {
    const started = Date.now();
    const result = await chatText({ providerId: "claude-opus", provider, apiKey: token, messages, onText: () => {} });
    assert.equal(result.text, "Done early.");
    assert.equal(result.usage.prompt_tokens, 5, "usage read from the stream");
    assert.equal(result.usage.completion_tokens, 7);
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
  } finally {
    delete process.env.FAKE_CLAUDE_TAIL_MS;
  }
});

await test("an outline returns at its result line, not when Claude Code exits", async () => {
  process.env.FAKE_CLAUDE_MODE = "ok";
  process.env.FAKE_CLAUDE_TAIL_MS = "3000";
  try {
    const started = Date.now();
    const result = await ask();
    assert.deepEqual(result.data, answer);
    assert.equal(result.usage.prompt_tokens, 110);
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
  } finally {
    delete process.env.FAKE_CLAUDE_TAIL_MS;
  }
});

await test("a reply cut short waits for Claude Code to say why", async () => {
  const { chatText } = await import("../../src/model/openai-compat.js");
  process.env.FAKE_CLAUDE_STOP = "max_tokens";
  try {
    await assert.rejects(
      chatText({ providerId: "claude-opus", provider, apiKey: token, messages, onText: () => {} }),
      (err) => err.status === 502 && /cut off/.test(err.message),
    );
  } finally {
    delete process.env.FAKE_CLAUDE_STOP;
  }
});

await test("a PDF reaches Claude Code as a document block, never as text", async () => {
  const { chatText } = await import("../../src/model/openai-compat.js");
  const { pdfPart } = await import("../../src/model/pdf.js");
  process.env.FAKE_CLAUDE_TEXT = "Three authors.";
  await chatText({
    providerId: "claude-opus",
    provider,
    apiKey: token,
    messages: [
      { role: "system", content: "READ THE PDF" },
      { role: "user", content: [pdfPart(new Uint8Array([37, 80, 68, 70])), { type: "text", text: "Who wrote it?" }] },
    ],
  });
  const { argv, stdin } = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.equal(argv[argv.indexOf("--input-format") + 1], "stream-json");
  const message = JSON.parse(stdin.trim());
  assert.deepEqual(message.message.content[0], {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
  });
  assert.equal(message.message.content[1].text, "Who wrote it?");
  assert.doesNotMatch(message.message.content[1].text, /base64/, "the bytes are not pasted into the prompt");
});

await test("the run's stages reach the extension, once per change", async () => {
  process.env.FAKE_CLAUDE_MODE = "think";
  const stages = [];
  const result = await ask({ onStage: (s) => stages.push(s) });
  assert.deepEqual(result.data, answer);
  // "reading" is held with the headers (HOLD_MS) and this run is past it by
  // then; a slow one opens the stream still reading and says so.
  assert.deepEqual(stages, ["thinking", "writing"]);
});

await test("a Claude Code that goes quiet is stopped by the bridge, in words", async () => {
  const quiet = createBridge({ token, log: () => {}, stallMs: 300 });
  await new Promise((resolve) => quiet.listen(0, "127.0.0.1", resolve));
  process.env.FAKE_CLAUDE_MODE = "hang";
  const hung = { ...provider, baseUrl: `http://127.0.0.1:${quiet.address().port}/v1/` };
  const started = Date.now();
  await assert.rejects(
    chatJson({ providerId: "claude-opus", provider: hung, apiKey: token, messages, schema: outlineSchema(1) }),
    (err) => {
      assert.equal(err.status, 504);
      assert.match(err.message, /went quiet.*stopped the run/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "ended by the stall timer, not by anything slower");
  quiet.close();
});

server.close();
globalThis.fetch = realFetch;
console.log(results.join("\n"));
console.log(`\nbridge: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
