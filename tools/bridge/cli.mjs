// One headless Claude Code run, streamed as the model writes it. Two modes:
// with a JSON schema, the structured outline (the StructuredOutput tool's
// input); without one, plain text, for the chat tab.

//
// The run is stripped to the one thing it is for. No tools but the
// StructuredOutput one --json-schema adds, no MCP servers, no settings files, no
// session saved to disk, and an empty working directory so no CLAUDE.md is
// picked up. What reaches the model is the prompt the extension built.
//
// SUBSCRIPTION: the child's environment has every variable that would make
// Claude Code bill an API key or a cloud account removed, so it can only run on
// the reader's own claude.ai login. See CLAUDE.md, Project values.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

const BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export const claudeBin = () => process.env.CLAUDE_BIN || "claude";

export function childEnv() {
  const env = { ...process.env };
  for (const name of BILLING_ENV) delete env[name];
  return env;
}

export class BridgeError extends Error {
  constructor(message, { status = 502, retryAfterSec } = {}) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const emptyDir = mkdtempSync(join(tmpdir(), "scholar-bridge-"));

/**
 * @param {object} args
 * @param {string} args.model one of MODELS
 * @param {string} args.system
 * @param {string} args.user
 * @param {object|null} args.schema JSON schema for structured output; null for text
 * @param {string[]} [args.documents] base64 PDFs, sent as document blocks so the
 *   model reads the rendered pages, not a text layer
 * @param {AbortSignal} args.signal aborts the child
 * @param {(text: string) => void} args.onDelta a slice of the JSON, or of the text
 * @param {() => void} args.onReset the model started its answer over
 * @param {() => void} args.onAlive any sign the run is still working
 * @returns {Promise<{structured?: object, text?: string, usage: object}>}
 */
export function runClaude({ model, system, user, schema, documents = [], signal, onDelta, onReset, onAlive }) {
  const args = [
    "-p",
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    "--system-prompt", system,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources", "",
    // A PDF can only travel as a document block, which only the stream-json
    // input carries; plain text keeps going in as the prompt itself.
    ...(documents.length ? ["--input-format", "stream-json"] : []),
  ];
  const child = spawn(claudeBin(), args, { cwd: emptyDir, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", kill, { once: true });

  child.stdin.on("error", () => {}); // An early exit closes stdin; the exit code says why.
  child.stdin.end(documents.length ? streamInput(documents, user) : user);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  const state = { text: !schema, outputIndex: null, outputs: 0, rejectedUntil: null, result: null };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (line) handleLine(line, state, { onDelta, onReset, onAlive });
    }
  });

  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      reject(new BridgeError(`Could not start Claude Code (${claudeBin()}): ${err.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (buffer.trim()) handleLine(buffer.trim(), state, { onDelta, onReset, onAlive });
      if (signal?.aborted) return reject(new BridgeError("cancelled", { status: 499 }));
      try {
        resolve(finish(state, code, stderr));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function streamInput(documents, text) {
  const content = [
    ...documents.map((data) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } })),
    { type: "text", text },
  ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

function handleLine(line, state, { onDelta, onReset, onAlive }) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Not a protocol line.
  }
  onAlive();

  if (msg.type === "rate_limit_event" && msg.rate_limit_info?.status === "rejected") {
    state.rejectedUntil = msg.rate_limit_info.resetsAt ?? null;
  } else if (msg.type === "result") {
    state.result = msg;
  } else if (msg.type === "stream_event") {
    const event = msg.event ?? {};
    const wanted = state.text ? event.content_block?.type === "text" : event.content_block?.name === "StructuredOutput";
    if (event.type === "content_block_start" && wanted) {
      state.outputIndex = event.index;
      // A second structured answer replaces the first; a second text block
      // (after a think, say) continues the reply.
      if (state.outputs++ > 0 && !state.text) onReset();
    } else if (event.type === "content_block_delta" && event.index === state.outputIndex) {
      const piece = state.text ? event.delta?.text : event.delta?.partial_json;
      if (typeof piece === "string" && piece) onDelta(piece);
    } else if (event.type === "content_block_stop" && event.index === state.outputIndex) {
      state.outputIndex = null;
    }
  }
}

function finish({ result, rejectedUntil, text }, code, stderr) {
  const retryAfterSec = rejectedUntil ? Math.max(1, Math.round(rejectedUntil - Date.now() / 1000)) : undefined;
  if (rejectedUntil || result?.api_error_status === 429) {
    const message = result?.result || "Claude Code usage limit reached.";
    throw new BridgeError(message, { status: 429, retryAfterSec });
  }
  if (!result) {
    throw new BridgeError(`Claude Code exited (${code}) without a result. ${stderr.trim()}`.trim());
  }
  if (result.is_error) {
    const status = result.api_error_status === 401 || result.api_error_status === 403 ? 401 : 502;
    throw new BridgeError(String(result.result || "Claude Code reported an error."), { status });
  }
  if (!text && (!result.structured_output || typeof result.structured_output !== "object")) {
    throw new BridgeError("Claude Code finished without a structured answer.");
  }
  if (text && typeof result.result !== "string") {
    throw new BridgeError("Claude Code finished without a reply.");
  }
  const u = result.usage ?? {};
  const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return {
    ...(text ? { text: result.result } : { structured: result.structured_output }),
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

/** What Claude Code is logged in as, so the bridge can refuse to bill an API key. */
export function authStatus() {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), ["auth", "status"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => resolve({ error: err.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: out.trim() || "no answer from `claude auth status`" });
      }
    });
  });
}
