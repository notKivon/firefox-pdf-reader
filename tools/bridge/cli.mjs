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
import { BridgeError, finish, handleLine, newState } from "./stream.mjs";

export { BridgeError };

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

const emptyDir = mkdtempSync(join(tmpdir(), "scholar-bridge-"));

// A run with no output from Claude Code for this long is stopped. Shorter than
// the extension's own watchdog (background/watchdog.js, 3 minutes), so a stuck
// CLI ends here with words the pane can show rather than as a dropped stream.
export const STALL_MS = 150_000;

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
 * @param {(stage: "reading"|"thinking"|"writing") => void} [args.onStage] what
 *   the run is doing now, said once per change
 * @param {number} [args.stallMs] how long without output before the run is stopped
 * @returns {Promise<{structured?: object, text?: string, usage: object}>}
 */
export function runClaude({ model, system, user, schema, documents = [], signal, onDelta, onReset, onAlive, onStage = () => {}, stallMs = STALL_MS }) {
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

  const state = newState(!schema);
  const stage = (next) => {
    if (state.stage === next) return;
    state.stage = next;
    onStage(next);
  };
  stage("reading");

  // Only Claude Code's own output counts as life. The HTTP side has a
  // keep-alive of its own, which says the bridge is up, not that the run is.
  let stalled = false;
  let quiet = null;
  const rearm = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      stalled = true;
      kill();
    }, stallMs);
  };
  rearm();
  const hooks = { onDelta, onReset, onAlive: () => { rearm(); onAlive(); }, stage };

  let buffer = "";
  let settled = false;
  let resolveRun;
  let rejectRun;
  const run = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  // Said once: when the answer is complete (and the child is stopped, since
  // what it does after that is not for the reader), or when the child exits.
  const settle = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(quiet);
    signal?.removeEventListener("abort", kill);
    if (signal?.aborted) return rejectRun(new BridgeError("cancelled", { status: 499 }));
    if (stalled) {
      const seconds = Math.round(stallMs / 1000);
      return rejectRun(new BridgeError(
        `Claude Code went quiet — no output for ${seconds} s — so the bridge stopped the run. Nothing was cached; trying again usually works.`,
        { status: 504 },
      ));
    }
    try {
      resolveRun(finish(state, code, stderr));
    } catch (err) {
      rejectRun(err);
    }
  };

  child.stdout.on("data", (chunk) => {
    if (settled) return;
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (line) handleLine(line, state, hooks);
      if (state.complete) {
        settle(null);
        kill();
        return;
      }
    }
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(quiet);
    rejectRun(new BridgeError(`Could not start Claude Code (${claudeBin()}): ${err.message}`));
  });
  child.on("close", (code) => {
    if (!settled && buffer.trim()) handleLine(buffer.trim(), state, hooks);
    settle(code);
  });
  return run;
}

function streamInput(documents, text) {
  const content = [
    ...documents.map((data) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } })),
    { type: "text", text },
  ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
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
