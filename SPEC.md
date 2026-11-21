# Scholar Reader — How it works

What each part does and why it is built the way it is. The rules the code must keep live in **CLAUDE.md** and are not restated here; release history and the reasoning behind past decisions are in **PROGRESS.md**.

## Repository layout

```
src/
  background/        the extension's event page — the only place a provider is called
    index.js         entry: wires interceptor, message router, toolbar button
    intercept.js     webRequest.onHeadersReceived → capture (or, as a fallback, redirect)
    capture.js       StreamFilter capture of the PDF response, header rewrite, hand-off
    skeleton.js      the scriptless reader-shaped page shown during a capture
    prefs.js         theme + outline width mirrored for skeleton pages
    router.js        runtime.onMessage handler; outline runs, the consent gate
    plan.js          the `plan` message: what would be sent, and where, without sending
    chat.js          chat-plan / chat / chat-history / chat-clear
    records.js       grant, open-doc, save-position, consents, revoke
    bypass.js        single-use per-tab pass for the escape hatch to the browser's own viewer
    watchdog.js      abandons a run with no sign of life as a `stalled` error; Stop cancels it
  viewer/            the reader page
    viewer.html/.js  two-pane shell and boot order
    source.js        captured bytes, interceptor URL, or a picked local file
    pdfview.js       pdfjs-dist PDFViewer setup, scrollToSection(), theme
    outline-pane.js  plan → card → grant → send, and the error states
    outline-progress.js  stage, elapsed time, silence, Stop
    outline-ready.js / outline-list.js / outline-sections.js  the finished outline
    confirm-card.js  the send-confirmation state of the outline pane
    provider-switch.js  the one model dropdown
    locate.js / locate-quote.js  which lines a bullet restates (no model involved)
    jump-flash.js / back-jump.js / scroll-spy.js  arrival band, Back, current section
    chat-pane.js / chat-render.js  the Chat tab
    math.js          KaTeX typesetting of $…$ and $$…$$
    pane-tabs.js / pane-resize.js / toolbar-fields.js / actions.js / download.js
    doc-meta.js      sha256 identity and PDF metadata
    debug-pane.js    the collapsed Extraction panel
    *.css            theme.css (tokens), controls, outline, chat, progress, debug, fonts
  extract/           text layer → lines → columns → sections, all without a model
    textlayer.js lines.js columns.js sections.js assemble.js anchor.js normalize.js stats.js
  model/             providers and the wire
    providers.js     provider descriptors (no keys)
    adapter.js       outline(document) → sections[]; strategy dispatch, fallback
    model-sections.js  one request for a provider that chooses its own sections
    prompts.js / paper-prompt.js / chat-prompt.js  prompts, schemas, versions
    transport.js / openai-compat.js / ollama-native.js / wire.js  the two wires
    pdf.js           sending the PDF itself
    align.js errors.js estimate.js partial-json.js
  store/             IndexedDB (background only) and storage.local
    db.js docs.js outlines.js cache-key.js consent.js quota.js inbox.js chats.js
    apikeys.js settings.js   (storage.local; readable by pages)
  settings/          the settings page, one *-section.js per section, model.js for the testable logic
tools/
  claude-bridge.mjs + bridge/   the local Claude Code bridge
  bridge-login.mjs   installs/removes the login LaunchAgent
  check-secrets.mjs  greps dist/ and tracked files for key-shaped strings
  package.mjs        XPI + source archive for AMO, gated on check:secrets and lint
  extract-pdf.mjs    the extension's own extraction, run in Node
  *-probe.mjs        real requests against a provider (spend quota or subscription usage)
  test/              npm test: Node, stubs, no network
fixtures/            saved extracted-section JSON for prompt iteration
docs/screenshots/    README images
esbuild.config.mjs
manifest.json
```

## background/intercept.js
- Registers `browser.webRequest.onHeadersReceived` per CLAUDE.md's interception rule.
- Reads the origin opt-out list from `storage.local` at registration and on change.
- Exposes `shouldIntercept(details) → boolean` as a pure function so it is unit-testable without the browser.
- On a match (and no bypass pass), `capture.js` takes the response when `canCapture` allows — a 200 in a real tab, no content encoding, StreamFilter present — and otherwise returns the old `redirectUrl`.

## background/capture.js
- `beginCapture(details, deps)` attaches the StreamFilter and returns the rewritten headers: `Content-Type: text/html; charset=utf-8`, the publisher's CSP and `Content-Disposition` dropped, `SKELETON_CSP` (`default-src 'none'; style-src 'unsafe-inline'; …`) added. `Content-Length` and caching headers are left alone.
- `onstart` writes `skeletonHead`; each `ondata` buffers the chunk and appends at most one `<style>` progress rule per whole percent (per 256 KB with no length). Nothing scripted is ever written.
- `onstop`: concatenate → `inbox.stash` → `openingRule` → `close` → `tabs.update(tabId, {url, loadReplace: true})`, retried without `loadReplace` if refused. An empty body, one over `MAX_CAPTURE_BYTES` (512 MB) or a failed stash navigates to the viewer **without** a token, so the viewer fetches the URL itself and surfaces any failure in its own error pane. `onerror` (tab closed, navigated away, network failure) navigates nowhere.
- The viewer gets the bytes by sending the router `{type: "capture", token}` → `{entry}`, never by opening `store/inbox.js` itself: an extension page in a **container tab** has its own IndexedDB partition, and Zen workspaces use containers.
- `store/inbox.js` entries are read, not consumed, so reloading the reader does not refetch a single-use link. They expire after `INBOX_TTL_MS` (1 h), swept on every stash and at background start.
- The skeleton's colours are copied from `theme.css`; `capture.test.mjs` fails when they drift.

## background/router.js
- `runtime.onMessage` handles `{type: "outline", hash, sections, meta}`, `{type: "plan", hash, sections, meta}` and `{type: "quota"}`, plus `capture`, `bypass`, and the record handlers in `background/records.js`:
  - `{type: "grant", hash, providerId, cacheKey}` → `{ok}`. The router derives the key and the model/destination from the descriptor itself, and refuses when the key the card showed is not the one it derives.
  - `{type: "open-doc", hash, url, meta}` → `{title, pageCount, position}`. `meta` is computed in the viewer (`viewer/doc-meta.js`, which also owns `sha256Hex`); only `title`, `authors`, `pageCount`, `arxivId`, `doi` are taken from it.
  - `{type: "save-position", hash, position: {page, scrollTop, scrollHeight}}` → `{ok}`.
  - `{type: "consents"}` → `{consents, docs}` and `{type: "revoke", hash}` / `{type: "revoke", all: true}` → `{count}`, for the settings page.
- **One IndexedDB partition: the background's.** No page (viewer or settings) imports an IndexedDB-backed store — `db`, `docs`, `consent`, `inbox`, `outlines`, `quota` — directly or transitively. An extension page in a **container tab** (Zen workspaces use them) has its own IndexedDB partition, so a grant written there is one the gate never sees. `partition.test.mjs` walks both pages' import graphs and fails otherwise. `storage.local` is per extension, not per container, so `apikeys.js` and `settings.js` may still be read by pages. Pages call the router through `viewer/ask.js`, which turns an `{error, message}` reply back into a throw.
- `plan` is the confirmation's data source: it resolves the provider, builds the cache key, checks the cache and the consent record, and returns `{cacheHit, consented, cacheKey, providerId, model, destination, label, strategy, sectionCount, chars, estTokens, estCost}` **without making any network request**. The viewer renders either the outline (cache hit), the confirm card (no consent), or the spinner (consented already).
- `outline` **refuses to call a provider unless `store/consent.js` holds a record for the cache key it is about to use** — the check is here, not in the viewer, per CLAUDE.md's send-confirmation rule. Refusal returns `{error: "consent-required", plan}` so the pane can render the card rather than an error.
- A fallback that would change `destination` mid-run aborts with `{error: "consent-required", plan}` for the new destination instead of sending.
- **All provider fetches originate here.** Extension background fetches for hosts in `host_permissions` are not subject to CORS; the viewer page's fetches would be. This is why the viewer never calls a provider directly, and why no API key is ever sent to the viewer context.

## viewer/confirm-card.js
The outline pane's first state for any document with no consent record. Implements CLAUDE.md's send-confirmation rule; it is a pane state, not a dialog.

- Drawn from the router's `plan` response: "Outline with [model ▾]" (the one model control, `provider-switch.js#modelChoice`), one sentence of what leaves and for whom ("Sends the 15-page PDF to Anthropic.", "Sends 19 sections of text to Google.", "Stays on this machine."), a cost only when the descriptor carries `pricing` ("About 2.4¢."), a missing key said before the click, and one **Generate outline** button.
- A provider sent extracted sections keeps a folded "Which sections" list — what exactly gets sent, after the References cut.
- The page asks the router to record the grant **before** sending (`grant`), so a crash mid-request cannot lose it and re-ask. The router's gate re-reads it regardless.
- No auto-dismiss and no timeout: an unanswered card stays. The paper is readable in the left pane regardless.

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
- Items are grouped into lines by `y` within a tolerance of `0.4 × modal item height`.
- Two columns are found per page. The gutter is the x between the two column centres that the fewest runs cross (`gutter`) — not the midpoint of the centres, which a running header or a wide left column defeats. Each page uses its own gutter where it shows two columns, the paper-wide value (the median of the pages') otherwise.
- A row whose runs meet across the gutter with only a word space between them is one full-width line (an abstract box, an author list), not two half-lines (`rowsRunningAcross`).
- Lines are emitted in reading order: on a two-column page, the left column top to bottom, then the right. Each line record keeps `x` and `right`, so a jump's arrival band can cover only its column.

## extract/sections.js and assemble.js
- Body font size = modal item height across the document, not per page (`stats.js`).
- **Bookmarks first:** when `getOutline()` returns them they are the sections, each placed on the line that carries its own title nearest the bookmark's y, then sorted into reading order.
- Otherwise a line is a heading candidate when it is short **and** set apart (larger than body, a bold face, or IEEE-style small capitals at body size such as "IV. RESULTS") **and** it is numbered (`1`, `3.2`, `IV.`, a lettered `A.` subsection where set apart) or in the vocabulary below. Numbered sentences and lines cut at a hyphen are not headings.
- Vocabulary: Abstract, Introduction, Background, Related Work, Preliminaries, Method(s), Methodology, Materials, Model, Data, Experiments, Experimental Setup, Evaluation, Results, Analysis, Discussion, Limitations, Future Work, Conclusion(s), References, Bibliography, Appendix, Acknowledg(e)ments.
- Text before the first heading becomes a first section, "Title and abstract" (or "Title and authors" when the abstract has its own heading).
- On References/Bibliography, stop and discard everything after. Hard cap of 40 sections.
- Each section record: `{ title, page, y, text, lines }`; `lines` (`{page, y, height, x, right, str}`) never leave the page — see below.
- `paper`: every line in reading order up to the References cut, for providers that choose their own sections.
- Fallback when fewer than 2 sections are found: ~1200-token chunks titled `Pages N–M`. Under 200 characters per page on average is a scanned PDF: no sections, no call.

## model/providers.js
Descriptors only — no keys. Each carries `label`, `baseUrl`, `model`, `keyRef` (the `storage.local` slot, or `null`), `destination` (the party the text reaches — consent and fallback are scoped by it), `strategy`, `limits`, `pricing` (per million tokens, read only by the confirm card), `promptStyle`, and where relevant `sections: "model"`, `pdf: true`, `pdfTokensPerPage`, `bridge: true`, `useNativeEndpoint`.

| id | model | destination | strategy | sections | style |
|---|---|---|---|---|---|
| `claude-opus` (default) | `claude-opus-5-5` | `anthropic` | whole-document | model | guidelines |
| `claude-sonnet` | `claude-sonnet-5-5` | `anthropic` | whole-document | model | guidelines |
| `claude-haiku` | `claude-haiku-5-5` | `anthropic` | whole-document | model | strict |
| `gemini-4-argon` / `-carbon` / `-hydrogen` / `-neon` | same | `google` | whole-document | model | guidelines |
| `ollama` | `gemma4:e4b` | `local` | per-section | extracted | strict |

- Claude goes through the local bridge (`baseUrl` `http://127.0.0.1:8765/v1/`, `keyRef: "claude-bridge"` — the bridge's token, not an Anthropic key), `pricing: null` because a subscription has no per-token price.
- Gemini 4 limits and pricing are not filled in: a guess on the confirm card would be worse than no line.
- `ollama` uses `useNativeEndpoint` and `params: { options: { num_ctx: 32768 }, think: false }` — see `model/ollama-native.js`.
- The module exports `DEFAULT_PROVIDER_ID` (`claude-opus`), `FALLBACK_ORDER` (Opus alone — nothing is switched to automatically), `getProvider(id)` which throws on an unknown id, and `fallbacksFor(id)`, which returns only ids in `FALLBACK_ORDER` of the same destination, in the reader's order.
- Test-only descriptors for the per-section-over-OpenAI and fallback paths live in `tools/test/test-providers.mjs`.

## model/adapter.js
- `outline(doc, sections, providerId)`:
  - `whole-document` → one request containing every section's text, returns all bullets plus the TL;DR.
  - `per-section` → one request per section, dispatched with concurrency 3, each resolving independently so the pane can fill progressively; then one reduce request for the TL;DR.
- **Sections with empty text are never sent** — `extract/assemble.js` keeps them deliberately (a parent heading whose first subsection follows immediately), but CLAUDE.md's "2–4 bullets per section" cannot apply to a section with nothing in it. They are excluded from the payload and re-inserted, bullet-less, at their original index before the result is returned. Under `per-section` an empty request would also be a wasted one.
- **Alignment is verified, not assumed.** `page` and `y` are re-attached from the input section at that index; the model's echoed `title` is compared against the input title and a mismatch — or a returned section count other than the number sent — is treated as a malformed response per CLAUDE.md. The check runs **before** the outline is written to the cache: an unverified outline must never become a cache entry, because cache hits render with no confirmation and no network request and would serve the bad jump targets forever.
- Wraps every call in the quota check **and the consent check**. On `rpd` exhaustion or HTTP 429, moves to the next same-destination entry of `FALLBACK_ORDER` and reports which provider actually served the result; when that runs out it raises `consent-required` for the next destination rather than crossing to it (CLAUDE.md).
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
- `PROMPT_VERSION` (currently 5) — bump on any prompt text or schema change; it is part of the cache and consent key.
- Schema for a provider sent extracted sections: `{ sections: [{ title, bullets: string[] }], tldr }`, section count pinned (`minItems` = `maxItems` = N). Order matches input order; the adapter re-attaches `page`/`y` by index and uses the echoed `title` **only as a checksum**.
- Whatever the schema can carry is put there, since structured output is constrained decoding: Gemini and Ollama both honour `minItems`/`maxItems` (measured).
- `promptStyle: "strict"` (Haiku, Gemma): extractive, 2–4 bullets, ≤ 20 words each, keep reported numbers verbatim, no bullets about the reference list, echo each title exactly. The word limit and extractiveness are not expressible in a schema, so they are measured, not enforced.
- `promptStyle: "guidelines"` (Opus, Sonnet, Gemini 4): the same intent written as guidance, bullet count and length left to the model; `bullets` keeps `minItems: 1` and loses `maxItems`. The title echo and JSON-only lines stay firm.
- Every prompt asks for maths as LaTeX, `$…$` inline and `$$…$$` displayed.
- `paper-prompt.js` is the schema and instructions for providers that choose their own sections (below).

## tools/claude-bridge.mjs (+ tools/bridge/)
- Loopback HTTP on `127.0.0.1:8765`, one route: `POST /v1/chat/completions`, answered as SSE so `openai-compat.js` reads it as it reads Gemini.
- Access: `Origin` must start with `moz-extension://`, and `Authorization: Bearer <token>` must match `~/.config/scholar-reader/bridge-token` (generated on first run, mode 600, `srb_` + hex). Model must be one of the three Claude ids; anything else is a 400.
- Runs `claude -p --model <id> --output-format stream-json --verbose --include-partial-messages --json-schema <schema> --system-prompt <system> --tools "" --strict-mcp-config --no-session-persistence --setting-sources ""` in an empty temp dir; the paper goes on stdin. The StructuredOutput tool's `input_json_delta`s are forwarded as content deltas, so the pane fills progressively.
- Headers are held up to 8 s so early failures keep their status: usage limit → 429 with `Retry-After` from the CLI's `rate_limit_event`; CLI error → 502 with its message; bad login → 401. After the 200 is committed, a failure is a `data: {"error": {status, message, retry_after}}` chunk, and a restarted answer is replaced by a `final_content` chunk. Only the run's own lines poke the stall watchdog through `onAlive` — data lines and `: alive`, never the bridge's timed `: keep-alive`, which says the bridge is up, not that the run is (2026-11-21: counting it let a hung CLI spin forever). The bridge kills a child silent for 150 s (`STALL_MS`) and answers 504 in words. It reports the run's stage as `{stage: "reading"|"thinking"|"writing"}` chunks, opening the stream at the first non-reading stage; the router forwards stages, and life at most every 5 s, to the pane's progress line (`viewer/outline-progress.js`). **Stop** sends `outline-stop`; the router cancels that hash's watchdog, the fetch aborts, the bridge sees the client go and kills the child, and the run ends as `cancelled`.
- A run is complete at its `result` line, or for a text reply at an `end_turn` `message_stop` (text and usage from the stream); the bridge answers then and stops the child, rather than waiting ~0.8–2.5 s for Claude Code to exit (`tools/bridge/stream.mjs`).
- Started at login by the LaunchAgent `local.scholar-reader.bridge`, which `tools/bridge-login.mjs` (`npm run bridge:login`, `-- --off`) writes: this checkout's `tools/claude-bridge.mjs` under the absolute node and a PATH holding `claude`, `RunAtLoad`, restarted on an unsuccessful exit every 30 s, log `~/Library/Logs/scholar-reader-bridge.log`. After a change to the bridge, `launchctl kickstart -k gui/$(id -u)/local.scholar-reader.bridge` restarts it — CLAUDE.md has sessions do this themselves.
- `node tools/bridge-probe.mjs [fixture] [provider]` runs one real outline through the running bridge and the real adapter (spends subscription usage).

## Chat tab
- `model/chat-prompt.js`: `CHAT_PROMPT_VERSION`, `chatMessages(sections, meta, history, question)`, `splitCitations(text, sections)` (case- and space-insensitive title match; unmatched citations stay as text).
- `model/openai-compat.js#chatText`: the same POST without `response_format`, streamed as text; `onText` gets the whole reply so far.
- `background/chat.js`: `chat-plan`, `chat` (gate, quota check, then stream `chat-progress` to the tab, count the request, then `appendTurn`), `chat-history`, `chat-clear`. Watchdog as for outlines. `canChat`: any provider without `useNativeEndpoint`.
- Consent (2026-11-18): Send is the approval. `viewer/chat-render.js#disclosure` is the line above the box; on Send, the pane asks the router for a `grant` of kind `chat` when the plan has none, then sends.
- Model choice everywhere is one `<select>` grouped by destination (`viewer/provider-switch.js#modelPicker`): under a finished outline, on the confirm card, and in the error state.
- `store/chats.js`: `{hash, messages: [{role, content, providerId, model, at}], updatedAt}`, capped at 60 messages.
- `viewer/pane-tabs.js` (Outline | Chat, remembered in `storage.local` as `paneTab`), `viewer/chat-pane.js` (states, composer, model picker, two-click Clear), `viewer/chat-render.js` (reply paragraphs and `- ` lists as DOM, citation links, the approval card), `viewer/chat.css`.
- Bridge: no schema means text mode. Text blocks are streamed, `result.result` is final, and earlier turns go into the prompt as a transcript, because `claude -p` takes one prompt.
- `node tools/chat-probe.mjs [fixture] [provider] [port]`: two real turns through a running bridge (spends subscription usage).

## Model-chosen sections
- `extract/sections.js` returns `paper`: every line in reading order up to the References cut, as `{page, y, height, str}`. The viewer sends `{page, y, str}` of it with `plan` and `outline`.
- `extract/anchor.js`: `paperText` (lines, `[page N]` markers, no numbers), `anchorSections(returned, paper)` (each heading found by normalised match at a line's start, run-in or wrapped onto a second line; forward search only; returns the placed prefix and the first heading that could not be placed), `bodiesOf` (each section's text and lines, heading lines excluded).
- `model/paper-prompt.js`: instructions and schema `{sections: [{heading, title, bullets}] (1–40), tldr}`; bullet style by `promptStyle`. `model/model-sections.js#paperOutline`: one request, progressive fill of the placed prefix, then the full placement as the checksum.
- `adapter.js#usesPaper(provider, paper)`: `sections: "model"`, whole-document, and a paper sent. `plan` then counts the paper's characters, reports `sectionCount: null`, `modelSections: true`.
- Cached outline sections carry `heading`; `viewer/outline-sections.js#resolvedSections` places them on the live extraction every open for bullet location, and hands them to the chat tab.
- `tools/extract-pdf.mjs paper.pdf [--json out] [--lines]` runs the extension's own extraction in Node (pdf.js's Node build swapped in); `tools/paper-probe.mjs out.json [provider]` runs one real outline of it.

## Sending the PDF
- `model/pdf.js`: `pdfFits` (≤ 30 MB, ≤ 100 pages), `sendsPdf(provider, pdf)` (`provider.pdf`), `pdfTokens` (per-page estimate on the descriptor: Claude 3,400, Gemini 1,700, measured), `pdfPart(bytes)` → `{type: "image_url", image_url: {url: "data:application/pdf;base64,…"}}`. Gemini's OpenAI-compatible endpoint refuses `type: "file"` and accepts this; the bridge maps it to `{type: "document", source: {type: "base64", media_type: "application/pdf"}}` and runs the CLI with `--input-format stream-json`.
- The viewer reads the bytes once from pdf.js (`doc.getData()`); `plan`/`chat-plan` get `pdfInfo` (size, pages), `outline`/`chat` get `pdf` (bytes, pages).
- `paper-prompt.js`: with a PDF, the system prompt says so and the user turn is `[pdf, "Outline the attached paper."]`; headings are copied as printed, number included. `chat-prompt.js`: the PDF in the first user turn, the section titles in the system prompt.
- `extract/anchor.js` placement tiers, strictest first over the remaining paper: exact start (≤ 3 joined lines), numbering-free start (a one-word heading must be the whole line), suffix of a single line (≥ 3 words). Unplaced sections: kept, `unplaced: true`, target of the previous placed section (or the paper's first line), no lines; > 50% unplaced is malformed (`model-sections.js`) and gets no line placement in the viewer.

## Typeset mathematics
- `katex@0.16.22` (pinned) bundled into `viewer.js`; `dist/katex.css` and its fonts beside Inter's in `dist/fonts/`, with its MIT licence.
- `viewer/math.js`: `mathParts` (`$$…$$`, `\[…\]`, `\(…\)`, `$…$` with the Markdown rule — no space just inside, no digit after the closing dollar; `\$` is a dollar), `mathNode` (KaTeX `throwOnError`, `trust: false`, `strict: "ignore"`, `maxSize` 20, `maxExpand` 500; failure → `.math-raw` with the source text), `withMath`, `repairTex` (backspace/form feed/tab before a letter back to `\b`/`\f`/`\t`).
- Used by `outline-list.js` (bullets — inside one `.outline-bullet-text` span, the row being a flex box — and the TL;DR) and `chat-render.js` (reply text between citations).

## Jumps
- Line records carry `x`, `right` (scale-1 viewport extent). `locate.js#spanTarget` returns `{page, y, yEnd, height, x, xEnd}`; `jump-flash.js` sizes the band to `x…xEnd` × scale; `pdfview.js` passes `x − 12` as the XYZ left.
- `paper-prompt.js` schema: each section also has `quotes: string[]`, index-aligned with `bullets`; `model-sections.js#alignedQuotes` keeps the alignment. `outline-list.js`: `locateQuote(quote) || locateBullet(bullet)`, then the heading.
- `viewer/locate-quote.js`: word stream with line indices, hyphen-joined; for each start on the quote's first or second word, the in-order match within quote length + 40%; most words wins, tightest span breaks ties; ≥ 4 words and ≥ 80% matched, else null.
- `chat-prompt.js` `CITATION`: `[§ Title]` or `[§ Title | "quote"]`; `chat-render.js` places the quote in the section's lines.
- `viewer/back-jump.js`: `remember()` (first of a run only, as a share of scroll height), `back()`, `dismiss()`; `#jump-back` in the PDF pane; Alt+← / Escape.
- `tools/paper-probe.mjs` reports quote/word/heading placement and takes `--out`.

## Contents pages and Elsevier layouts
- `anchor.js#starts`: a line that is the heading followed only by a 1–4 digit number is a contents entry and does not match. An unfound first section is placed at line 0, not unplaced.
- `columns.js`: `columnVerdict` takes the median page ratio; `layoutPage` uses the page's own `detectColumns` boundary when it finds two columns; `rowsRunningAcross` marks every run of a row whose neighbouring runs meet across the boundary with a gap under max(4, 0.8 × body height) as spanning.
- `locate-quote.js`: NFKC (ligature glyphs), Greek letters → names, two adjacent stream words may make one quoted word, window = 2 × quote length, accept ≥ 80% or (≥ 10 words and ≥ 60%).

## store/db.js
IndexedDB `scholar-reader`, version 4, opened only by the background:
- `docs` — key `hash`; `{ hash, title, authors, doi, arxivId, pageCount, urls[], lastOpened, lastPage, scrollTop }`
- `outlines` — key `hash:providerId:model:strategy:promptVersion`; `{ key, hash, sections, tldr, createdAt, usage }`
- `consents` — key the cache key (or the chat key); `{ key, hash, providerId, model, destination, kind, grantedAt }`, with a `hash` index so every grant for one document can be revoked together.
- `quota` — key `providerId:pacificDate`; `{ key, count }`
- `inbox` (v3) — key the capture token; captured PDF bytes awaiting their viewer tab, 1 h TTL.
- `chats` (v4) — key `hash`; the last 60 messages of the paper's conversation.

Each upgrade only creates its store: an absent grant correctly reads as "ask". The manifest requests `unlimitedStorage`.

## External services
- **Claude Code** — logged in with the user's claude.ai subscription; the bridge refuses any other auth method.
- **Google AI Studio** — the user's own key, entered in settings.
- **Ollama** — the macOS desktop app, `gemma4:e4b` pulled. Because launchd starts it, `OLLAMA_ORIGINS` is set with `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"` and the app restarted; that does not survive a reboot.
- **addons.mozilla.org** — unlisted signing; the procedure is in README. Zen enforces Gecko's signature requirement and its `xpinstall.signatures.required` pref cannot be overridden, so a permanent install needs a signed XPI; `about:debugging` is the development path.

## Testing
`npm test` runs every suite in Node against stubs (`tools/test/`): no network, no key, no browser. What the suites hold, by area:
- **Interception and capture** — `shouldIntercept` by Content-Type, the opt-out list, StreamFilter capture with no script written into the publisher's page, every fallback to the redirect.
- **Partition** — neither page's import graph reaches an IndexedDB store.
- **Extraction** — `lines`, `extract-rules`, `normalize`; regenerate `fixtures/` whenever extraction changes.
- **Adapter and router** — a response with a section dropped, added or retitled is malformed and never cached; empty-text sections reach no provider; a 429 stops rather than crossing destinations; the gate refuses an unconsented send even when the page claims consent.
- **Send confirmation** — a fresh paper makes zero provider requests until the button; reopening after approval does not re-ask; a different provider, model or prompt version does; a scanned PDF shows no card.
- **Cache and quota** — a reopen makes zero requests; counters roll over on the Pacific date (stubbed).
- **Jumps** — quote and word placement, contents pages skipped, the arrival band's column.
- **Bridge** — a fake `claude` CLI: flags and stdin, no API key in the child's environment, stages, stall, Stop, early finish.
- **Secrets** — `npm run check:secrets` passes on a build made after entering a real key in settings.

Real-provider checks are by hand and spend quota or subscription usage: `npm run probe`, `tools/prod-check.mjs`, `tools/paper-probe.mjs`, `tools/chat-probe.mjs`, `tools/bridge-probe.mjs`. Behaviour in Zen is checked by the user.
