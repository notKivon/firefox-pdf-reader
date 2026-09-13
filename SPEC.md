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
    locate.js        which lines of a section a bullet restates (no model involved)
    provider-switch.js  change model on a finished outline
    confirm-card.js  the send-confirmation state of the outline pane
    theme.css        :root dark tokens + [data-theme="light"] override
  extract/
    textlayer.js     getTextContent → positioned items
    columns.js       column clustering, reading-order sort
    sections.js      heading detection, section assembly, References cutoff
  model/
    providers.js     provider descriptors (no keys)
    adapter.js       outline(document) → sections[]; strategy dispatch, fallback
    transport.js     picks the wire a provider is spoken to over
    openai-compat.js fetch against an OpenAI-compatible chat-completions endpoint
    ollama-native.js fetch against Ollama's own /api/chat (NDJSON, `options`)
    wire.js          JSON decode + the two failures both transports share
    prompts.js       PROMPT_VERSION + prompt builders + JSON schema
  store/
    db.js            IndexedDB open/upgrade
    docs.js          document records, reading position
    outlines.js      outline cache, cache key construction
    consent.js       per-cache-key send consent records
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
- `runtime.onMessage` handles `{type: "outline", hash, sections, meta}`, `{type: "plan", hash, sections, meta}` and `{type: "quota"}`.
- `plan` is the confirmation's data source: it resolves the provider, builds the cache key, checks the cache and the consent record, and returns `{cacheHit, consented, cacheKey, providerId, model, destination, label, strategy, sectionCount, chars, estTokens, estCost}` **without making any network request**. The viewer renders either the outline (cache hit), the confirm card (no consent), or the spinner (consented already).
- `outline` **refuses to call a provider unless `store/consent.js` holds a record for the cache key it is about to use** — the check is here, not in the viewer, per CLAUDE.md's send-confirmation rule. Refusal returns `{error: "consent-required", plan}` so the pane can render the card rather than an error.
- A fallback that would change `destination` mid-run aborts with `{error: "consent-required", plan}` for the new destination instead of sending.
- **All provider fetches originate here.** Extension background fetches for hosts in `host_permissions` are not subject to CORS; the viewer page's fetches would be. This is why the viewer never calls a provider directly, and why no API key is ever sent to the viewer context.

## viewer/confirm-card.js
The outline pane's first state for any document with no consent record. Implements CLAUDE.md's send-confirmation rule; it is a pane state, not a dialog.

- `render(plan, { onConfirm, onPickProvider })` draws, from the router's `plan` response:
  - document title and page count;
  - `N sections · ~M tokens` (characters ÷ 4, stated as approximate — a real tokeniser is not worth bundling for a number shown to one reader);
  - the destination in words: `"Sent to Google (Gemini 3.8 Flash)"` or `"Stays on this machine (Gemma 4 E4B, 127.0.0.1)"`;
  - estimated cost when the descriptor carries `pricing`, rendered to one decimal of a cent and marked `est.`;
  - a primary **Generate outline** button, and a secondary control listing the other-destination providers so the local model can be chosen deliberately.
- `onConfirm` writes the consent record **before** sending, so a crash mid-request cannot lose the grant and re-ask.
- Section titles are listed in a collapsed `<details>` — "what exactly gets sent" is the question the card exists to answer, and the titles are the honest short answer. The References cutoff has already run by this point, so what the list shows is what goes.
- No auto-dismiss and no timeout: an unanswered card stays. The paper is readable in the left pane regardless, which is why blocking here is acceptable.

## viewer/locate.js
Implements CLAUDE.md's "a bullet jumps to the lines it restates". Given a bullet and its section's own extracted lines, returns `{page, y, yEnd, height}` or `null`.

- Tokenises both, dropping function words and the vocabulary a summary is written in ("the section reports that…"), and keeping decimals whole so `28.4` stays one token — the most distinctive thing a results bullet carries.
- Scores every window of 1–4 consecutive lines. A token is weighted `1 / (1 + log2(lines it appears on))`, so a word on one line nails that line and a word on half the section says nothing.
- **A word the section does not contain at all is weighted too, against the match.** This is the difference between a matcher that works and one that does not: scoring only over the words that happen to be present gave 99% recall *and* placed three passages in four taken from entirely different papers, because one incidental shared word is a perfect score when it is the only word counted. With absent words counted, the same recall holds and foreign placement falls to 0.3%.
- A match needs at least 2 distinct matched words and a score of 0.42 to be acted on; below that it returns `null` and the caller jumps to the heading, exactly as before the feature existed.
- Nothing here is persisted. The span is recomputed from the live extraction each time the document opens, so a cached outline needs no migration and no bullet position is ever stored.

`extract/assemble.js` attaches the lines each section needs for this as `section.lines` (`{page, y, height, str}`). **`viewer/outline-pane.js` strips that field at the send boundary** — the model payload is `text` and nothing else, and a test asserts no outbound message carries it.

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
    label: "Gemini 3.8 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyRef: "gemini",
    destination: "google",
    strategy: "whole-document",
    limits: { rpd: 10_000, rpm: 1_000, tpm: 2_000_000 },
    pricing: { inPerM: 0.75, outPerM: 3.75 },
    params: { reasoning_effort: "low" },
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  },
  "gemini-dev": {
    label: "Gemini 3.5 Flash-Lite (development)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.5-flash-lite",
    keyRef: "gemini",
    destination: "google",
    strategy: "per-section",
    limits: { rpd: 150_000, rpm: 4_000, tpm: 4_000_000 },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
  "ollama": {
    label: "Gemma 4 E4B (local)",
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "gemma4:e4b",
    keyRef: null,
    destination: "local",
    strategy: "per-section",
    limits: null,
    useNativeEndpoint: true,
    params: { options: { num_ctx: 32768 }, think: false },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
};
```

Limits above are the **real Tier 1 (paid) numbers**, confirmed 2026-09-11 — the free-tier figures this spec was drafted with were placeholders and were an order of magnitude out. `tpm` is recorded because it, not `rpd`, is the limit a whole-document request can realistically approach.

`destination` names the party the text reaches, and is what consent and automatic fallback are scoped by (CLAUDE.md). `pricing` is per million tokens, and exists only so the confirm card can state a cost; nothing else reads it. The Gemini figures are promotional and double on 2027-01-01 — the constant needs updating by hand then.

`ollama` gained `useNativeEndpoint` and `think: false` at step 12; see `model/ollama-native.js` below for why the OpenAI-compatible layer could not carry `num_ctx`.

`gemini-prod` **keeps `strategy: "whole-document"`**, decided 2026-09-11 after the original reason for it (a 20-requests-per-day cap) turned out never to have existed. It stays because it is cheapest in tokens, gives a TL;DR written from the full text rather than from a digest of its own bullets, and keeps quota and 429 fallback to one clean request per paper; the alignment risk that argued against it is answered by the adapter's title checksum rather than by changing strategy. `per-section` is not the poor relation here — it is what `gemini-dev` and `ollama` use, so that path is built and exercised regardless of what the default does.

The module also exports `DEFAULT_PROVIDER_ID` (`"gemini-prod"` — the user's stated preference) and `FALLBACK_ORDER` (`["gemini-prod", "gemini-dev"]`, Google only: the local model is never an automatic fallback target, per the user's preference), plus `getProvider(id)` which throws on an unknown id so a bad settings value fails by name, and `fallbacksFor(id)` which returns the order filtered to the same `destination`.

## model/adapter.js
- `outline(doc, sections, providerId)`:
  - `whole-document` → one request containing every section's text, returns all bullets plus the TL;DR.
  - `per-section` → one request per section, dispatched with concurrency 3, each resolving independently so the pane can fill progressively; then one reduce request for the TL;DR.
- **Sections with empty text are never sent** — `extract/assemble.js` keeps them deliberately (a parent heading whose first subsection follows immediately), but CLAUDE.md's "2–4 bullets per section" cannot apply to a section with nothing in it. They are excluded from the payload and re-inserted, bullet-less, at their original index before the result is returned. Under `per-section` an empty request would also be a wasted one.
- **Alignment is verified, not assumed.** `page` and `y` are re-attached from the input section at that index; the model's echoed `title` is compared against the input title and a mismatch — or a returned section count other than the number sent — is treated as a malformed response per CLAUDE.md. The check runs **before** the outline is written to the cache: an unverified outline must never become a cache entry, because cache hits render with no confirmation and no network request and would serve the bad jump targets forever.
- Wraps every call in the quota check **and the consent check**. On `rpd` exhaustion or HTTP 429, moves to the next same-destination entry in the user's configured fallback order and reports which provider actually served the result; when that runs out it raises `consent-required` for the next destination rather than crossing to it (CLAUDE.md).
- Under `per-section`, consent is checked once for the run, not per request — the cache key is the same for every section of one document.
- Returns `{ sections: [{title, page, y, bullets: []}], tldr, providerId, model, usage }`.

## model/openai-compat.js
- `POST {baseUrl}chat/completions`, `Authorization: Bearer <key>` when `keyRef` is set.
- `response_format: { type: "json_schema", json_schema: { name: "outline", strict: true, schema } }`.
- Streams with `stream: true` and parses SSE incrementally so partial sections can render. Under `per-section` this is trivial — each response is a small complete object. Under `whole-document`, which is what the default provider uses, progressive fill means scanning the partially accumulated JSON for **complete** objects inside `sections[]` and emitting those; the checksum above still runs over the finished response, so a partially rendered pane is never a cached one.
- Ollama needs no `Authorization` header, but **does** check the `Origin` header server-side — this is not browser CORS. `OLLAMA_ORIGINS` must include `moz-extension://*`. Detect a refused origin specifically and surface that exact remedy rather than a generic network error. The remedy names both routes, because the one that applies depends on how Ollama was started (see `wire.js` and PROGRESS.md).
- Gemini's OpenAI-compatibility layer is documented as beta and may not carry `thoughtsTokenCount` into OpenAI's usage shape. If thinking-token counts are needed, that one provider may call the native endpoint instead; the `useNativeEndpoint` escape hatch in the descriptor exists for exactly this and does not reshape the adapter.

## model/ollama-native.js
The escape hatch above, taken — by Ollama rather than by Gemini, and for a different reason. **Ollama's OpenAI-compatible layer silently drops the `options` object**, so `num_ctx` never reaches the server and the model loads at its 4096-token default; a ~13k-token prompt sent that way reported `prompt_tokens: 2051` and returned an empty completion, with nothing to say the input had been truncated. Sections in the fixture set reach 7.5k tokens, so this is the common case. Measured 2026-09-13 against Ollama 0.34.0 and `/api/ps`.

- `POST {origin}/api/chat`, NDJSON rather than SSE: one JSON object per line, deltas in `message.content`, a final `done: true` object carrying `prompt_eval_count` / `prompt_eval_cached_count` / `eval_count`, which are mapped onto OpenAI's usage names so the adapter has one code path.
- The JSON schema travels as `format`, not wrapped in `response_format`. `minItems`/`maxItems` are honoured, verified the same way Gemini's were.
- `thinking` arrives on the same message as `content` and is dropped — it is not the answer, and appending it would break the JSON. `think: false` in the descriptor's `params` turns it off entirely.
- **A request that would not fit the context window is refused before it is sent**, because Ollama truncates instead of failing: a section over the window would otherwise be summarised from whatever survived the cut, silently. Under `per-section` that refusal costs that one section, not the run — see `isSectionLocal` in `errors.js`.
- Same `chatJson` signature and return shape as `openai-compat.js`; `transport.js` picks between them off `useNativeEndpoint`. The adapter never learns which answered.

## model/prompts.js
- `export const PROMPT_VERSION = 1;` — bump on any prompt text or schema change.
- JSON schema: `{ sections: [{ title: string, bullets: string[] }], tldr: string }`. Section order must match input order. The adapter re-attaches `page`/`y` by index and uses the echoed `title` **only as a checksum** — the echo is never the source of truth for where a bullet points, but it is what makes a drift detectable.
- Constrain in the schema whatever the schema can carry, since structured output is constrained decoding and anything expressible there is enforced rather than merely asked for: `bullets` as `minItems: 2, maxItems: 4`, and `sections` pinned to exactly the number of sections sent (`minItems` = `maxItems` = N).
- ⚠️ **Whether those two keywords actually bind is unverified.** OpenAI's `strict` mode rejects `minItems`/`maxItems` as unsupported keywords; Gemini's native schema type accepts them; Gemini's OpenAI-compatibility layer is beta and its keyword coverage is undocumented. Step 7's first real call must establish which — if they are rejected or silently ignored, the counts fall back to prompt instruction plus the adapter's post-hoc check, and the adapter's verification becomes the only real guarantee.
- The ≤20-word limit and extractiveness cannot be expressed in a schema at all, so they are prompt-side and checked by measurement, not enforced.
- Prompt states: extractive only, 2–4 bullets, ≤20 words each, keep reported numbers verbatim, no bullets about the reference list, and echo each section's title exactly as given.

## store/db.js
IndexedDB `scholar-reader`, version 1:
- `docs` — key `hash`; `{ hash, title, authors, doi, arxivId, pageCount, urls[], lastOpened, lastPage, scrollTop }`
- `outlines` — key `hash:providerId:model:strategy:promptVersion`; `{ key, hash, sections, tldr, createdAt, usage }`
- `consents` — key the same cache key; `{ key, hash, providerId, model, destination, grantedAt }`, plus a non-unique `hash` index so every grant for one document can be revoked together. Written only from the confirm card's accept path.
- `quota` — key `providerId:pacificDate`; `{ key, count }`

Version 2 adds `consents`; the upgrade path creates the store and nothing else, since an absent grant is correctly read as "ask".

Request `unlimitedStorage` in the manifest.

## External service setup
- **Google AI Studio** ✅ — key created by the user and held outside the repo; it is entered in extension settings at step 14. Tier 1 (paid). Real limits recorded in `model/providers.js`.
- **Ollama** ✅ — installed 2026-09-13 as the macOS **desktop app** (Ollama 0.34.0), `gemma4:e4b` pulled. Because launchd starts it rather than a shell, `OLLAMA_ORIGINS` is set with `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"` and the app restarted — not by exporting it in a terminal, which the app never sees. That setting does not survive a reboot.
- **addons.mozilla.org** ⏸️ (post-v1) — user submits the built XPI for **unlisted** signing and downloads the signed file. Zen enforces Gecko's signature requirement and its `xpinstall.signatures.required` pref cannot be overridden, so unsigned permanent installation is impossible; `about:debugging` temporary loading is the development path and does not survive a restart.

## Verification per area
- **Interception** — an arXiv abstract-page PDF link and a publisher DOI link both open in the custom viewer; an opted-out origin does not.
- **Extraction** — the debug panel lists correct section titles for ten papers from the user's own reading list, including at least three two-column ones. Saved to `fixtures/` as it goes.
- **Adapter** — outline produced from a fixture with no PDF in the loop; a forced 429 falls through to the next same-destination provider, and stops rather than crossing to the local one. A response with a section dropped, added or retitled is rejected as malformed and never cached. Empty-text sections reach no provider.
- **Schema enforcement** — establish on the first real call whether Gemini's OpenAI-compat layer honours `minItems`/`maxItems`: send an N-section payload and confirm N sections come back, and that no section carries fewer than 2 or more than 4 bullets. Record the answer in PROGRESS.md, because everything the schema does not enforce has to be caught by the adapter instead.
- **Output quality under whole-document** — measured over the fixtures, not eyeballed on one: bullets outside 2–4, bullets over 20 words **as a function of position in the response** (the long-tail drift that a schema cannot prevent), and whether Results sections keep their reported numbers. `gpt3.json` is the stress case at 32 sections and ~51k est. tokens.
- **Send confirmation** — opening a fresh paper issues **zero** provider requests until the button is clicked (devtools network panel, and the quota counter unchanged); reopening it after approval does not re-ask; changing the provider or bumping `PROMPT_VERSION` does re-ask; a scanned PDF shows no card at all.
- **Cache** — reopening a document issues zero network requests (verify in devtools network panel).
- **Quota** — counter increments per request and resets when the Pacific date string changes (test by stubbing the date function).
- **Secrets** — `npm run check:secrets` passes on a build made after entering a real key in settings.
