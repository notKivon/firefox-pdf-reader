# Scholar Reader — Build Spec

Implementation detail for each part. Core domain rules live in **CLAUDE.md** — follow those exactly; this file doesn't restate them. Step order and live status are in **PROGRESS.md**.

## Repository layout

```
src/
  background/
    index.js         entry: wires interceptor + message router
    intercept.js     webRequest.onHeadersReceived → redirect to viewer
    router.js        runtime.onMessage handler; the ONLY place provider calls happen
  viewer/
    viewer.html      two-pane shell
    viewer.js        entry: boots PDFViewer, wires panes
    pdfview.js       pdfjs-dist PDFViewer setup, scrollToSection(), theme
    outline-pane.js  renders sections/bullets, click-to-jump, scroll-spy
    theme.css        :root dark tokens + [data-theme="light"] override
  extract/
    textlayer.js     getTextContent → positioned items
    columns.js       column clustering, reading-order sort
    sections.js      heading detection, section assembly, References cutoff
  model/
    providers.js     provider descriptors (no keys)
    adapter.js       outline(document) → sections[]; strategy dispatch, fallback
    openai-compat.js fetch against an OpenAI-compatible chat-completions endpoint
    prompts.js       PROMPT_VERSION + prompt builders + JSON schema
  store/
    db.js            IndexedDB open/upgrade
    docs.js          document records, reading position
    outlines.js      outline cache, cache key construction
    quota.js         per-provider request counters keyed by Pacific date
  settings/
    settings.html    key entry, provider selection, origin opt-out
    settings.js
fixtures/            saved extracted-section JSON for prompt iteration
tools/
  check-secrets.mjs  greps dist/ for key prefixes
esbuild.config.mjs
manifest.json
```

## background/intercept.js
- Registers `browser.webRequest.onHeadersReceived` per CLAUDE.md's interception rule.
- Reads the origin opt-out list from `storage.local` at registration and on change.
- Exposes `shouldIntercept(details) → boolean` as a pure function so it is unit-testable without the browser.

## background/router.js
- `runtime.onMessage` handles `{type: "outline", hash, sections, meta}` and `{type: "quota"}`.
- **All provider fetches originate here.** Extension background fetches for hosts in `host_permissions` are not subject to CORS; the viewer page's fetches would be. This is why the viewer never calls a provider directly, and why no API key is ever sent to the viewer context.

## extract/columns.js
- Input: text items with `transform` (pdf.js gives `[a,b,c,d,x,y]`), `width`, `height`, `fontName`.
- Group items into lines by `y` within a tolerance of `0.4 × modal item height`.
- Column detection: take each item's x-midpoint; run 2-means on the midpoints. Accept the 2-column split only when the gap between cluster centres exceeds `0.15 × page width` **and** both clusters hold at least 20% of items. Otherwise treat the page as single-column.
- Emit lines in reading order: for two columns, all of the left column top-to-bottom, then the right.

## extract/sections.js
- Body font size = modal item height across the document, not per page.
- A line is a heading candidate when it is under 80 characters **and** (height > 1.1 × body size **or** its `fontName` matches `/bold|black|semibold/i`), **and** it either matches `/^(\d+(\.\d+)*|[IVXL]+)[.)\s]/` or appears in the vocabulary below (case-insensitive, allowing a trailing colon).
- Vocabulary: Abstract, Introduction, Background, Related Work, Preliminaries, Method, Methods, Methodology, Materials, Model, Data, Experiments, Experimental Setup, Evaluation, Results, Analysis, Discussion, Limitations, Future Work, Conclusion, Conclusions, References, Bibliography, Appendix, Acknowledgements, Acknowledgments.
- On matching References/Bibliography, stop and discard everything after.
- Each section record: `{ title, page, y, text }` where `y` is the heading line's PDF-space y for `scrollPageIntoView`.
- Fallback when fewer than 2 sections are found: split the body text into ~1200-token chunks titled `Pages N–M`. A degraded outline beats an error.

## model/providers.js
Descriptors only — no keys. Exact initial content:

```js
export const PROVIDERS = {
  "gemini-prod": {
    label: "Gemini 3.8 Flash (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyRef: "gemini",
    strategy: "whole-document",
    limits: { rpd: 20, rpm: 10 },
    params: { reasoning_effort: "low" },
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  },
  "gemini-dev": {
    label: "Gemini 3.5 Flash-Lite (development)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.5-flash-lite",
    keyRef: "gemini",
    strategy: "per-section",
    limits: { rpd: 500, rpm: 15 },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
  "ollama": {
    label: "Gemma 4 E4B (local)",
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "gemma4:e4b",
    keyRef: null,
    strategy: "per-section",
    limits: null,
    params: { options: { num_ctx: 32768 } },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
};
```

`limits.rpd` for `gemini-prod` is a **placeholder pending step 3**, where the user reads the real number off their AI Studio rate-limit page. Update it there rather than assuming.

## model/adapter.js
- `outline(doc, sections, providerId)`:
  - `whole-document` → one request containing every section's text, returns all bullets plus the TL;DR.
  - `per-section` → one request per section, dispatched with concurrency 3, each resolving independently so the pane can fill progressively; then one reduce request for the TL;DR.
- Wraps every call in the quota check. On `rpd` exhaustion or HTTP 429, moves to the next entry in the user's configured fallback order and reports which provider actually served the result.
- Returns `{ sections: [{title, page, y, bullets: []}], tldr, providerId, model, usage }`.

## model/openai-compat.js
- `POST {baseUrl}chat/completions`, `Authorization: Bearer <key>` when `keyRef` is set.
- `response_format: { type: "json_schema", json_schema: { name: "outline", strict: true, schema } }`.
- Streams with `stream: true` and parses SSE incrementally so partial sections can render.
- Ollama needs no `Authorization` header, but **does** check the `Origin` header server-side — this is not browser CORS. `OLLAMA_ORIGINS` must include `moz-extension://*`. Detect a refused origin specifically and surface that exact remedy rather than a generic network error.
- Gemini's OpenAI-compatibility layer is documented as beta and may not carry `thoughtsTokenCount` into OpenAI's usage shape. If thinking-token counts are needed, that one provider may call the native endpoint instead; keep an `useNativeEndpoint` escape hatch in the descriptor rather than reshaping the adapter.

## model/prompts.js
- `export const PROMPT_VERSION = 1;` — bump on any prompt text or schema change.
- JSON schema: `{ sections: [{ title: string, bullets: string[] }], tldr: string }`. Section order must match input order; the adapter re-attaches `page`/`y` by index rather than trusting the model to echo them.
- Prompt states: extractive only, 2–4 bullets, ≤20 words each, keep reported numbers verbatim, no bullets about the reference list.

## store/db.js
IndexedDB `scholar-reader`, version 1:
- `docs` — key `hash`; `{ hash, title, authors, doi, arxivId, pageCount, urls[], lastOpened, lastPage, scrollTop }`
- `outlines` — key `hash:providerId:model:strategy:promptVersion`; `{ key, hash, sections, tldr, createdAt, usage }`
- `quota` — key `providerId:pacificDate`; `{ key, count }`

Request `unlimitedStorage` in the manifest.

## External service setup
- **Google AI Studio** ⏸️ — user creates an API key and reads their actual rate limits from the AI Studio rate-limit page. Values needed back: the key (entered in extension settings, never pasted into the repo) and the real RPD/RPM for `gemini-3.8-flash` and `gemini-3.5-flash-lite`.
- **Ollama** ⏸️ — user installs Ollama, pulls `gemma4:e4b`, and starts it with `OLLAMA_ORIGINS="moz-extension://*"`. Nothing is needed back except confirmation that `curl http://127.0.0.1:11434/api/tags` responds.
- **addons.mozilla.org** ⏸️ (post-v1) — user submits the built XPI for **unlisted** signing and downloads the signed file. Zen enforces Gecko's signature requirement and its `xpinstall.signatures.required` pref cannot be overridden, so unsigned permanent installation is impossible; `about:debugging` temporary loading is the development path and does not survive a restart.

## Verification per area
- **Interception** — an arXiv abstract-page PDF link and a publisher DOI link both open in the custom viewer; an opted-out origin does not.
- **Extraction** — the debug panel lists correct section titles for ten papers from the user's own reading list, including at least three two-column ones. Saved to `fixtures/` as it goes.
- **Adapter** — outline produced from a fixture with no PDF in the loop; a forced 429 falls through to the next provider.
- **Cache** — reopening a document issues zero network requests (verify in devtools network panel).
- **Quota** — counter increments per request and resets when the Pacific date string changes (test by stubbing the date function).
- **Secrets** — `npm run check:secrets` passes on a build made after entering a real key in settings.
