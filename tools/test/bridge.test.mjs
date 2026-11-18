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

server.close();
globalThis.fetch = realFetch;
console.log(results.join("\n"));
console.log(`\nbridge: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
