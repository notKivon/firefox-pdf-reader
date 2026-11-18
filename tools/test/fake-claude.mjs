#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in bridge.test.mjs.
// FAKE_CLAUDE_MODE picks the run: ok, retry, limit, error. The answer is the
// schema-shaped JSON in FAKE_CLAUDE_ANSWER; argv is written to FAKE_CLAUDE_ARGV.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const answer = process.env.FAKE_CLAUDE_ANSWER ?? '{"sections":[],"tldr":""}';
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const event = (e) => say({ type: "stream_event", event: e });

if (process.argv[2] === "auth") {
  say({ loggedIn: true, authMethod: "claude.ai" });
  process.exit(0);
}

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_ARGV) {
    writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env }));
  }
  say({ type: "system", subtype: "init" });

  if (mode === "limit") {
    say({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.round(Date.now() / 1000) + 3600 } });
    say({ type: "result", is_error: true, api_error_status: 429, result: "You've hit your usage limit." });
    return;
  }
  if (mode === "error") {
    say({ type: "result", is_error: true, api_error_status: 404, result: "There's an issue with the selected model." });
    return;
  }

  // No --json-schema: a chat turn, answered as text blocks.
  if (!process.argv.includes("--json-schema")) {
    const reply = process.env.FAKE_CLAUDE_TEXT ?? "A plain reply.";
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(0, 5) } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(5) } });
    event({ type: "content_block_stop", index: 0 });
    say({ type: "result", is_error: false, result: reply, usage: { input_tokens: 5, output_tokens: 7 } });
    return;
  }

  const block = (index, text) => {
    event({ type: "content_block_start", index, content_block: { type: "tool_use", name: "StructuredOutput", input: {} } });
    const half = Math.floor(text.length / 2);
    event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: text.slice(0, half) } });
    event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: text.slice(half) } });
    event({ type: "content_block_stop", index });
  };
  if (mode === "retry") block(1, '{"sections":[{"title":"wrong"');
  block(mode === "retry" ? 2 : 1, answer);
  say({
    type: "result",
    is_error: false,
    structured_output: JSON.parse(answer),
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 },
  });
});
