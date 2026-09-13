// Ollama's own `/api/chat`, used instead of its OpenAI-compatible `/v1/` layer.
// Selected by `useNativeEndpoint` on the descriptor — SPEC.md's escape hatch,
// taken here rather than reshaping the adapter, which still sees one call.
//
// Why it is needed, measured 2026-09-13 rather than assumed: the OpenAI layer
// silently drops the `options` object, so `num_ctx` never reaches the server and
// the model loads at its 4096-token default (`/api/ps` reports the truth). A
// ~13k-token prompt sent that way came back reporting `prompt_tokens: 2051` and
// an empty completion — the input was truncated to fit and nothing said so.
// Sections in the fixture set reach 7.5k tokens, so that is the common case and
// not a tail one. `/api/chat` takes `options` and loads the model at 32768.
//
// It also separates `thinking` from `content`, which is the other half of that
// empty completion: gemma4 thinks, and the OpenAI layer counted those tokens
// without emitting any answer. Here the thinking is simply not the answer, and
// `think: false` turns it off (3× faster on the probe, 199 eval tokens vs 631).
import { ProviderError } from "./errors.js";
import { estimateTokens } from "./estimate.js";
import { completeSections } from "./partial-json.js";
import { decodeJson, networkError, originRefusedError } from "./wire.js";

// Room left for the model's own answer inside the context window. Bullets come
// back at roughly a tenth of the input, so this is generous for a section.
const COMPLETION_RESERVE = 2048;

/**
 * Same signature and same return shape as `openai-compat.js`'s `chatJson`, so
 * the adapter needs no branch of its own.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {object} args.provider descriptor from providers.js
 * @param {object[]} args.messages chat messages
 * @param {object} args.schema JSON schema the response must match
 * @param {(sections: object[]) => void} [args.onPartial]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{data: object, usage: object|null, text: string}>}
 */
export async function chatJson({ providerId, provider, messages, schema, onPartial, signal }) {
  checkFits(messages, provider, providerId);

  const body = {
    model: provider.model,
    messages,
    stream: true,
    // Native takes the JSON schema directly; there is no response_format wrapper.
    format: schema,
    ...(provider.params ?? {}),
  };

  let response;
  try {
    response = await fetch(new URL("/api/chat", provider.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw networkError(cause, providerId, provider);
  }

  if (!response.ok) throw await httpError(response, providerId, provider);

  const { content, usage } = await readStream(response, { onPartial, providerId, provider });
  return { data: decodeJson(content, providerId), usage, text: content };
}

// Asked before the request is sent, because the failure it prevents is silent:
// Ollama truncates a prompt that does not fit and answers anyway, so a section
// over the window would be summarised from whatever survived the cut with
// nothing on screen to say so. An estimate is enough — the margin between a
// section that fits and one that does not is thousands of tokens, not tens.
function checkFits(messages, provider, providerId) {
  const numCtx = provider.params?.options?.num_ctx;
  if (!numCtx) return;
  const chars = messages.reduce((sum, message) => sum + String(message.content ?? "").length, 0);
  const estimate = estimateTokens(chars);
  if (estimate + COMPLETION_RESERVE <= numCtx) return;
  throw new ProviderError(
    `This section is too large for ${provider.label}: ~${estimate.toLocaleString("en")} tokens ` +
      `against a ${numCtx.toLocaleString("en")}-token context window. Sending it would silently ` +
      `truncate the text, so it was not sent. A cloud provider has room for it.`,
    { kind: "too-large", providerId },
  );
}

// NDJSON, not SSE: one JSON object per line, deltas in `message.content`, and a
// final object with `done: true` carrying the token counts.
async function readStream(response, { onPartial, providerId, provider }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = null;
  let emitted = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        if (!line) continue;
        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // A partial line cannot happen here, but a blank one can.
        }
        // Ollama reports a mid-stream failure as an object, not an HTTP status.
        if (chunk.error) {
          throw new ProviderError(`${provider.label}: ${chunk.error}`, { kind: "http", providerId });
        }
        if (chunk.done) usage = countsOf(chunk);
        // `thinking` arrives on the same message and is deliberately dropped:
        // it is not the answer, and appending it would break the JSON.
        const delta = chunk.message?.content;
        if (typeof delta === "string" && delta) {
          content += delta;
          if (onPartial) {
            const sections = completeSections(content);
            if (sections.length > emitted) {
              onPartial(sections);
              emitted = sections.length;
            }
          }
        }
      }
    }
  } catch (cause) {
    if (cause?.name === "AbortError" || cause instanceof ProviderError) throw cause;
    throw networkError(cause, providerId, provider);
  }

  return { content, usage };
}

// Mapped to OpenAI's names so the adapter's usage arithmetic is one code path.
// Cached prompt tokens count towards the prompt: they were in the text sent,
// whatever the server saved by not re-evaluating them.
function countsOf(chunk) {
  const prompt = (chunk.prompt_eval_count ?? 0) + (chunk.prompt_eval_cached_count ?? 0);
  const completion = chunk.eval_count ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

async function httpError(response, providerId, provider) {
  const detail = (await response.text().catch(() => "")).slice(0, 300);

  if (response.status === 403 || /origin/i.test(detail)) {
    return originRefusedError(providerId, response.status);
  }
  // The one local failure with a remedy as specific as the origin one.
  if (response.status === 404) {
    return new ProviderError(
      `Ollama has no model named ${provider.model}. Pull it with \`ollama pull ${provider.model}\`.`,
      { kind: "http", providerId, status: 404 },
    );
  }
  return new ProviderError(
    `${provider.label} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    { kind: "http", providerId, status: response.status },
  );
}
