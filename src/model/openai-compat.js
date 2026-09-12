// One POST to an OpenAI-compatible /chat/completions endpoint, streamed, with
// the response decoded against a JSON schema.
//
// This runs in the background page only. Extension background fetches to hosts
// in `host_permissions` are not subject to CORS and no API key ever reaches the
// viewer context — that is why the viewer never calls a provider itself.
import { ProviderError } from "./errors.js";
import { completeSections } from "./partial-json.js";

/**
 * @param {object} args
 * @param {string} args.providerId
 * @param {object} args.provider descriptor from providers.js
 * @param {string|null} args.apiKey null when the descriptor has no `keyRef`
 * @param {object[]} args.messages chat messages
 * @param {object} args.schema JSON schema the response must match
 * @param {(sections: object[]) => void} [args.onPartial] complete sections so far
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{data: object, usage: object|null, text: string}>}
 */
export async function chatJson({ providerId, provider, apiKey, messages, schema, onPartial, signal }) {
  const body = {
    model: provider.model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "outline", strict: true, schema },
    },
    stream: true,
    stream_options: { include_usage: true },
    ...(provider.params ?? {}),
  };

  const headers = { "Content-Type": "application/json" };
  if (provider.keyRef) {
    if (!apiKey) {
      throw new ProviderError(
        `No API key is stored for ${provider.label}. Add one in Scholar Reader's settings.`,
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

  const { content, usage } = await readStream(response, { onPartial, providerId, provider });
  return { data: decode(content, providerId), usage, text: content };
}

// SSE: `data: {json}` lines, terminated by `data: [DONE]`. Deltas accumulate
// into one content string; usage arrives on a final chunk with no choices.
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
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // A keep-alive or a comment line; not fatal.
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content;
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
    if (cause?.name === "AbortError") throw cause;
    throw networkError(cause, providerId, provider);
  }

  return { content, usage };
}

function decode(content, providerId) {
  if (!content.trim()) {
    throw new ProviderError("The model returned an empty response.", { kind: "malformed", providerId });
  }
  try {
    return JSON.parse(content);
  } catch (cause) {
    // CLAUDE.md: prose parsing is never a fallback. A malformed response is an
    // error the reader sees.
    throw new ProviderError("The model's response was not valid JSON.", {
      kind: "malformed",
      providerId,
      cause,
    });
  }
}

async function httpError(response, providerId, provider) {
  const detail = (await response.text().catch(() => "")).slice(0, 300);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new ProviderError(`${provider.label} is rate limited.`, {
      kind: "rate-limit",
      providerId,
      status: 429,
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    });
  }
  // Ollama checks the Origin header server-side; this is not browser CORS and
  // no permission grant fixes it. The remedy is specific, so say it.
  if (provider.destination === "local" && (response.status === 403 || /origin/i.test(detail))) {
    return new ProviderError(
      "Ollama refused the request's origin. Restart it with " +
        'OLLAMA_ORIGINS="moz-extension://*" ollama serve',
      { kind: "origin-refused", providerId, status: response.status },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(`${provider.label} rejected the API key (${response.status}).`, {
      kind: "auth",
      providerId,
      status: response.status,
    });
  }
  return new ProviderError(
    `${provider.label} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    { kind: "http", providerId, status: response.status },
  );
}

function networkError(cause, providerId, provider) {
  if (cause?.name === "AbortError") return cause;
  const remedy =
    provider.destination === "local"
      ? ` Is Ollama running at ${provider.baseUrl}?`
      : " Check the network connection.";
  return new ProviderError(`Could not reach ${provider.label}.${remedy}`, {
    kind: "network",
    providerId,
    cause,
  });
}
