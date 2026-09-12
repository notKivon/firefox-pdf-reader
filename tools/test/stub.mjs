// A stubbed OpenAI-compatible endpoint: records every request, streams SSE back.
export function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new Blob([body]).stream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function contentChunks(text, { pieces = 6, usage } = {}) {
  const size = Math.ceil(text.length / pieces);
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ choices: [{ delta: { content: text.slice(i, i + size) } }] });
  }
  if (usage) out.push({ choices: [], usage });
  return out;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

// `reply(body, requestIndex)` returns a Response, or a string/object to stream.
export function installFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url: String(url), model: body.model, body, headers: init.headers };
    calls.push(call);
    const answer = await reply(body, calls.length - 1, call);
    if (answer instanceof Response) return answer;
    const text = typeof answer === "string" ? answer : JSON.stringify(answer);
    return sse(contentChunks(text, { usage: USAGE }));
  };
  return calls;
}

// A well-formed answer echoing exactly the titles it was sent.
export function goodAnswer(body, { tldr = "A paper about things. It works." } = {}) {
  const titles = titlesFrom(body);
  const sections = titles.map((title) => ({ title, bullets: [`Says ${title} first.`, `Says ${title} again.`] }));
  return body.response_format.json_schema.schema.properties.tldr === undefined
    ? { sections }
    : { sections, tldr };
}

export function titlesFrom(body) {
  const user = body.messages.at(-1).content;
  return [...user.matchAll(/^Title: (.+)$/gm)].map((m) => m[1]);
}

export function rateLimited() {
  return new Response("rate limit exceeded", { status: 429, headers: { "retry-after": "30" } });
}
