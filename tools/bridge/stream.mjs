// Reading Claude Code's stream-json output: one protocol line at a time, into
// the state runClaude finishes from.
//
// A run is over when its answer is, not when the process exits. Measured
// 2026-11-21: a structured answer's `result` line arrives ~0.8 s before the CLI
// exits, and a text reply is whole ~2.5 s before that, because Claude Code then
// makes a post-turn summary request of its own. `state.complete` says the
// answer is in hand, and runClaude stops the child there.

export class BridgeError extends Error {
  constructor(message, { status = 502, retryAfterSec } = {}) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** @param {boolean} text a chat turn (no schema) rather than an outline */
export function newState(text) {
  return {
    text,
    outputIndex: null,
    outputs: 0,
    rejectedUntil: null,
    result: null,
    stage: null,
    // What the stream itself says, for a text reply finished before `result`.
    reply: "",
    usage: {},
    stopReason: null,
    complete: false,
  };
}

export function handleLine(line, state, { onDelta, onReset, onAlive, stage }) {
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
    state.complete = true;
  } else if (msg.type === "stream_event") {
    streamEvent(msg.event ?? {}, state, { onDelta, onReset, stage });
  }
}

function streamEvent(event, state, { onDelta, onReset, stage }) {
  const wanted = state.text ? event.content_block?.type === "text" : event.content_block?.name === "StructuredOutput";
  if (event.type === "message_start") {
    // A fresh message (Claude Code retrying, say) is a fresh answer's usage.
    state.usage = { ...(event.message?.usage ?? {}) };
    state.stopReason = null;
  } else if (event.type === "message_delta") {
    Object.assign(state.usage, event.usage ?? {});
    state.stopReason = event.delta?.stop_reason ?? state.stopReason;
  } else if (event.type === "message_stop") {
    // With no tools, a text reply that ended its turn is the whole reply. Any
    // other ending (max_tokens, a refusal) waits for `result` to say what it was.
    if (state.text && state.stopReason === "end_turn" && state.outputs > 0 && !state.rejectedUntil) {
      state.complete = true;
    }
  }
  if (event.type === "content_block_start" && event.content_block?.type === "thinking") stage("thinking");
  if (event.type === "content_block_start" && wanted) {
    stage("writing");
    state.outputIndex = event.index;
    // A second structured answer replaces the first; a second text block
    // (after a think, say) continues the reply.
    if (state.outputs++ > 0 && !state.text) onReset();
  } else if (event.type === "content_block_delta" && event.index === state.outputIndex) {
    const piece = state.text ? event.delta?.text : event.delta?.partial_json;
    if (typeof piece === "string" && piece) {
      if (state.text) state.reply += piece;
      onDelta(piece);
    }
  } else if (event.type === "content_block_stop" && event.index === state.outputIndex) {
    state.outputIndex = null;
  }
}

export function finish(state, code, stderr) {
  const { rejectedUntil, text } = state;
  // A text reply finished from the stream has no `result` yet: the stream's
  // own text and usage stand in for it.
  const result = state.result ?? (state.complete ? { is_error: false, result: state.reply, usage: state.usage } : null);
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
