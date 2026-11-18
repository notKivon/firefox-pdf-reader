// The bridge's HTTP face: an OpenAI-compatible POST /v1/chat/completions on
// loopback, answered as SSE so `src/model/openai-compat.js` reads it unchanged.
//
// A loopback port that runs Claude for whoever asks is reachable by every page
// the browser opens, so two checks stand in front of it: the Origin must be an
// extension's, and the request must carry the bridge's own token. Neither alone
// is enough: a page cannot forge Origin, but another local program can.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BridgeError, MODELS, runClaude } from "./cli.mjs";

const MAX_BODY = 16 * 1024 * 1024;
// Headers are held this long so an early failure (usage limit, bad model,
// logged out) still goes back as a real HTTP status rather than inside a 200.
const HOLD_MS = 8_000;
const KEEPALIVE_MS = 15_000;

export function createBridge({ token, log = console.log }) {
  const expected = Buffer.from(`Bearer ${token}`);

  return createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return fail(res, 404, "Not found.");
      if (!String(req.headers.origin ?? "").startsWith("moz-extension://")) {
        return fail(res, 403, "Only the Scholar Reader extension may use this bridge.");
      }
      const auth = Buffer.from(String(req.headers.authorization ?? ""));
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        return fail(res, 401, "The bridge token is missing or wrong. Paste it into Scholar Reader's settings.");
      }
      const request = parseRequest(await readBody(req));
      log(`[bridge] ${request.model}: ${request.user.length.toLocaleString("en")} chars`);
      await serve(req, res, request, log);
    } catch (err) {
      if (err instanceof BridgeError) return fail(res, err.status, err.message);
      log("[bridge] unexpected", err);
      fail(res, 500, `Bridge error: ${err.message}`);
    }
  });
}

function parseRequest(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BridgeError("Request body is not JSON.", { status: 400 });
  }
  if (!MODELS.has(parsed.model)) {
    throw new BridgeError(`Model "${parsed.model}" is not one the bridge runs.`, { status: 400 });
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const text = (role) =>
    messages.filter((m) => m?.role === role && typeof m.content === "string").map((m) => m.content).join("\n\n");
  // With a schema: the outline. Without: a chat turn, answered as plain text.
  const schema = parsed.response_format?.json_schema?.schema ?? null;
  if (schema !== null && typeof schema !== "object") {
    throw new BridgeError("response_format.json_schema.schema is not a schema.", { status: 400 });
  }
  const turns = messages.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string");
  if (turns.at(-1)?.role !== "user") throw new BridgeError("No user message.", { status: 400 });
  return { model: parsed.model, system: text("system"), user: transcript(turns), schema };
}

// `claude -p` takes one prompt, so earlier turns travel inside it. A single
// user message — every outline request — goes as it is.
function transcript(turns) {
  if (turns.length === 1) return turns[0].content;
  const earlier = turns
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "Reader" : "You"}: ${m.content}`)
    .join("\n\n");
  return `The conversation so far:\n\n${earlier}\n\nThe reader's new message:\n\n${turns.at(-1).content}`;
}

async function serve(req, res, request, log) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let committed = false;
  let streamed = "";
  let keepalive = null;
  const commit = () => {
    if (committed) return;
    committed = true;
    clearTimeout(hold);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    keepalive = setInterval(() => res.write(": keep-alive\n\n"), KEEPALIVE_MS);
  };
  const hold = setTimeout(commit, HOLD_MS);
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const delta = (content) => send({ choices: [{ index: 0, delta: { content } }] });

  const started = Date.now();
  try {
    const { structured, text, usage } = await runClaude({
      ...request,
      signal: controller.signal,
      onDelta: (text) => {
        commit();
        streamed += text;
        delta(text);
      },
      // A second StructuredOutput call replaces the first; the final chunk
      // below carries the whole answer, so nothing is sent for the reset.
      onReset: () => {},
      onAlive: () => {
        if (committed) res.write(": alive\n\n");
      },
    });
    commit();
    if (text !== undefined) {
      if (text !== streamed) send({ final_content: text, choices: [] });
    } else if (!sameJson(streamed, structured)) {
      send({ final_content: JSON.stringify(structured), choices: [] });
    }
    send({ choices: [], usage });
    res.write("data: [DONE]\n\n");
    log(`[bridge] ${request.model}: done in ${Math.round((Date.now() - started) / 1000)} s, ` +
      `${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
  } catch (err) {
    if (controller.signal.aborted) return log("[bridge] client went away; run stopped");
    const status = err instanceof BridgeError ? err.status : 502;
    log(`[bridge] ${request.model}: failed (${status}) ${err.message}`);
    if (!committed) {
      clearTimeout(hold);
      return fail(res, status, err.message, err.retryAfterSec);
    }
    send({ error: { status, message: err.message, retry_after: err.retryAfterSec ?? null } });
  } finally {
    clearTimeout(hold);
    clearInterval(keepalive);
    if (!res.writableEnded) res.end();
  }
}

function sameJson(text, value) {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BridgeError("Request too large.", { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function fail(res, status, message, retryAfterSec) {
  if (res.headersSent) return res.end();
  const headers = { "Content-Type": "application/json" };
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { message } }));
}
