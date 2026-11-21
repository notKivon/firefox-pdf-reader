// One POST to an OpenAI-compatible /chat/completions endpoint, streamed, with
// the response decoded against a JSON schema.
//
// This runs in the background page only. Extension background fetches to hosts
// in `host_permissions` are not subject to CORS and no API key ever reaches the
// viewer context — that is why the viewer never calls a provider itself.
import { ProviderError } from "./errors.js";
import { completeSections } from "./partial-json.js";
import { decodeJson, networkError, originRefusedError } from "./wire.js";

/**
 * @param {object} args
 * @param {string} args.providerId
 * @param {object} args.provider descriptor from providers.js
 * @param {string|null} args.apiKey null when the descriptor has no `keyRef`
 * @param {object[]} args.messages chat messages
 * @param {object} args.schema JSON schema the response must match
 * @param {(sections: object[]) => void} [args.onPartial] complete sections so far
 * @param {() => void} [args.onAlive] the run showed life: any line but the
 *   bridge's own `: keep-alive`, which says the bridge is up, not that the run is
 * @param {(stage: string) => void} [args.onStage] "reading", "thinking" or
 *   "writing": from the bridge as it changes; from any provider, "writing" at
 *   the first token
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{data: object, usage: object|null, text: string}>}
 */
export async function chatJson({ providerId, provider, apiKey, messages, schema, onPartial, onAlive, onStage, signal }) {
  const response = await post({
    providerId,
    provider,
    apiKey,
    signal,
    extra: { response_format: { type: "json_schema", json_schema: { name: "outline", strict: true, schema } } },
    messages,
  });
  const { content, usage } = await readStream(response, { onPartial, onAlive, onStage, providerId, provider });
  return { data: decodeJson(content, providerId), usage, text: content };
}

/**
 * The chat tab's turn: the same POST with no schema, answered as plain text.
 * `onText` gets the whole reply so far on every delta.
 *
 * @param {object} args as chatJson, minus `schema` and `onPartial`
 * @param {(text: string) => void} [args.onText]
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function chatText({ providerId, provider, apiKey, messages, onText, onAlive, signal }) {
  const response = await post({ providerId, provider, apiKey, signal, extra: {}, messages });
  const { content, usage } = await readStream(response, { onText, onAlive, providerId, provider });
  if (!content.trim()) {
    throw new ProviderError("The model returned an empty reply.", { kind: "malformed", providerId });
  }
  return { text: content, usage };
}

async function post({ providerId, provider, apiKey, signal, extra, messages }) {
  const body = {
    model: provider.model,
    messages,
    ...extra,
    stream: true,
    stream_options: { include_usage: true },
    ...(provider.params ?? {}),
  };

  const headers = { "Content-Type": "application/json" };
  if (provider.keyRef) {
    if (!apiKey) {
      throw new ProviderError(
        provider.bridge
          ? `No bridge token is stored for ${provider.label}. Start the bridge with \`npm run bridge\` and paste the token it prints into Scholar Reader's settings.`
          : `No API key is stored for ${provider.label}. Add one in Scholar Reader's settings.`,
        { kind: "auth", providerId },
      );
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(new URL("chat/completions", provider.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw networkError(cause, providerId, provider);
  }

  if (!response.ok) throw await httpError(response, providerId, provider);
  return response;
}

// SSE: `data: {json}` lines, terminated by `data: [DONE]`. Deltas accumulate
// into one content string; usage arrives on a final chunk with no choices.
//
// Two extensions, both sent only by the Claude bridge (tools/bridge/server.mjs):
// `final_content` replaces what was streamed when the model started its answer
// over, and `error` is a failure after the 200 was already committed.
async function readStream(response, { onPartial, onText, onAlive, onStage, providerId, provider }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = null;
  let emitted = 0;
  let stage = null;
  const setStage = (next) => {
    if (next === stage) return;
    stage = next;
    onStage?.(next);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        // A stuck `claude -p` behind a healthy bridge still gets this one, so it
        // is not life: counting it let a hung run spin forever (2026-11-21).
        if (line && line !== ": keep-alive") onAlive?.();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // A keep-alive or a comment line; not fatal.
        }
        if (chunk.error) {
          const { status = 502, message = "", retry_after: retryAfter } = chunk.error;
          throw toError(status, String(message).slice(0, 300), retryAfter, providerId, provider);
        }
        if (typeof chunk.final_content === "string") {
          content = chunk.final_content;
          onText?.(content);
        }
        if (chunk.usage) usage = chunk.usage;
        if (typeof chunk.stage === "string") setStage(chunk.stage);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          setStage("writing");
          content += delta;
          onText?.(content);
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

async function httpError(response, providerId, provider) {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  return toError(response.status, detail, response.headers.get("retry-after"), providerId, provider);
}

function toError(status, detail, retryAfterHeader, providerId, provider) {
  const response = { status };
  if (response.status === 429) {
    const retryAfter = Number(retryAfterHeader);
    return new ProviderError(`${provider.label} is rate limited.${bridgeDetail(provider, detail)}`, {
      kind: "rate-limit",
      providerId,
      status: 429,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    });
  }
  // A local endpoint that refuses an origin is refusing it server-side; that is
  // not browser CORS and the remedy is specific. Shared with the native
  // transport because the rule belongs to the destination, not to the wire.
  if (provider.destination === "local" && (response.status === 403 || /origin/i.test(detail))) {
    return originRefusedError(providerId, response.status);
  }
  if (response.status === 401 || response.status === 403) {
    const what = provider.bridge ? "bridge token or the Claude Code login" : "API key";
    return new ProviderError(`${provider.label} rejected the ${what} (${response.status}).${bridgeDetail(provider, detail)}`, {
      kind: "auth",
      providerId,
      status: response.status,
    });
  }
  return new ProviderError(
    provider.bridge
      ? `${provider.label} returned ${response.status}.${bridgeDetail(provider, detail)}`
      : `${provider.label} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    { kind: "http", providerId, status: response.status },
  );
}

// The bridge's error bodies are its own words about Claude Code, written for the
// reader; a public API's are not, so only the bridge's are shown on these paths.
function bridgeDetail(provider, detail) {
  if (!provider.bridge || !detail) return "";
  // A bridge started before the chat tab existed (step 22) asks every request
  // for a schema. It is still running old code; the fix is a restart.
  if (/JSON schema is required/.test(detail)) {
    return " The bridge is running older code than the extension: stop it with Ctrl+C and run `npm run bridge` again.";
  }
  try {
    const message = JSON.parse(detail)?.error?.message;
    return message ? ` ${message}` : "";
  } catch {
    return ` ${detail}`;
  }
}
