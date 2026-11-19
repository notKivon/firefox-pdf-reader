# Project: Scholar Reader

A Firefox/Zen browser extension that replaces the browser's built-in PDF viewer with a two-pane academic reader: the paper on the left, an AI-generated section outline on the right. Clicking a bullet scrolls the PDF to that section. Built for one user reading research papers; not distributed publicly.

This file loads every session. Implementation detail is in **SPEC.md**; live build status and "where to resume" is in **PROGRESS.md**. **Read all three at the start of every session.**

## Tech stack
- Plain JavaScript (ES modules). **No TypeScript.**
- `esbuild` for bundling — one config, no framework, no dev server.
- `pdfjs-dist` — the `PDFViewer` component from `web/pdf_viewer.mjs`, bundled. Not the prebuilt generic viewer, not a CDN copy.
- Manifest V3, **Firefox flavour**: event-page background script (`"background": {"scripts": [...]}`), NOT a service worker.
- Storage: `browser.storage.local` for settings; IndexedDB for documents, outlines and cached state.
- Model providers over HTTP, OpenAI-compatible chat-completions shape.
- Target browser: **Zen** (Firefox-based, macOS). Firefox itself should work but is not the test target.

## Code rules
- Plain JS, ES modules, no TypeScript, no JSX, no framework.
- ~200 lines per file maximum; split by responsibility rather than growing a file.
- Every async boundary has an explicit error path that surfaces in the UI. A failed model call must never leave the outline pane in a silent spinner.
- No `localStorage` for anything that must survive; IndexedDB or `storage.local` only.
- Dark theme is the default and must be defined as CSS custom properties on `:root`, with a light override — never the reverse.
- All times are stored as epoch milliseconds. Any date shown to the user renders in **Asia/Hong_Kong**. The one exception is the provider quota day (see Core domain logic).
- Ask before deleting any file.

## Core domain logic (must match exactly — do not drift)

### Document identity
- A document's identity is `sha256` of its **raw PDF bytes**, hex-encoded, computed with `crypto.subtle.digest`. Never the URL.
- The same paper fetched from a different URL is the same document and must hit the same cache entry.

### PDF interception
- The background script listens on `webRequest.onHeadersReceived` with `["blocking", "responseHeaders"]`, `types: ["main_frame"]`.
- A response is treated as a PDF when its `Content-Type` header matches `/application\/pdf/i`. **URL extension is never used as the trigger** — publisher and arXiv PDFs are served from extensionless URLs.
- On match, the PDF is **captured, not fetched again** (changed 2026-09-27 at the user's request; it used to redirect and let the viewer refetch). A `webRequest.filterResponseData` StreamFilter keeps the browser's own response; the tab meanwhile shows a scriptless picture of the reader with a progress bar, written into that response under a CSP with `default-src 'none'`; the bytes go to the IndexedDB `inbox` store and the tab moves to `viewer.html?file=<encodeURIComponent(originalUrl)>&capture=<token>` with `loadReplace`. Reason: publishers that sign PDF links for one use and bot-check the rest (Elsevier's `pdfft`) refuse the second request with a 403. **Nothing executable is ever written into a publisher's page.**
- The redirect to `viewer.html?file=<…>` (the viewer then fetches the URL) remains only as the fallback: no tab (`tabId < 0`), a 206, a `Content-Encoding` other than identity, no StreamFilter, or a capture that could not be handed over.
- Firefox only permits redirecting `http:` and `https:` requests. `file://` PDFs are opened through an explicit "Open local file" control in the viewer instead.
- A per-origin opt-out list in settings suppresses interception for listed hosts.

### Section extraction
- If `pdfDoc.getOutline()` returns bookmarks, those are the sections and heuristics are skipped.
- Otherwise sections are derived from the text layer (see SPEC.md for the algorithm).
- **Text before the first heading is kept** as a first section, "Title and abstract" (or "Title and authors" when the abstract has its own heading). It used to be dropped — on a paper whose first heading was missed, outlines and chat began halfway through the results (2026-11-18).
- Each page uses its own gutter where it shows one, the paper-wide value (the median of the pages', not the mean) otherwise; a row whose runs meet across the gutter with only a word space between them is one full-width line, not two half-lines (2026-11-19, an Elsevier paper whose abstract and Table-1 pages came out interleaved).
- The column gutter is the x between the two columns that the fewest runs cross (2026-11-19; a running header across the middle defeated the edge-gap rule of the day before), not the midpoint of their centres. Bookmarks are placed on the line that carries their own title, nearest the bookmark's y, and sections are in reading order — on a two-column page the y alone lands in the wrong column (2026-11-19); IEEE headings ("IV. RESULTS" in small capitals at body size, "A. Key Findings") are recognised; numbered sentences and lines cut at a hyphen are not headings (2026-11-18).
- Extraction **stops at the References/Bibliography heading**. Reference lists are never sent to a model.
- A document whose extracted text is under 200 characters per page on average is treated as a **scanned PDF**: the outline pane says so plainly and no model call is made. OCR is out of scope.
- Hard cap of 40 sections per document.
- **Providers with `sections: "model"` (every Claude and Gemini 4 provider) choose their own sections** (2026-11-18, at the user's request). **They are sent the PDF itself** (2026-11-19, at the user's request: the text layer flattened superscripts, scrambled equations and leaked figure labels and running heads), as an OpenAI-style `image_url` part with a `data:application/pdf` URL — Gemini takes that shape directly, the bridge turns it into a Claude document block — when the PDF is at most 30 MB and 100 pages; otherwise the extracted lines in reading order, page markers, References cut, no line numbers. Either way they return each section's printed heading. `extract/anchor.js` finds each one, in order, among the paper's own lines — words only, numbering optional, at the end of a column-merged line, over up to three lines; never a table-of-contents entry (the heading followed only by a page number); and a first section whose heading cannot be found starts at the paper's first line — and that line gives the section its page and y. The local model, being per-section, keeps the extracted sections.

### Send confirmation (no document reaches a model unasked)
- **No document's text is sent to any model until the user confirms it for that document.** This holds for every provider, including the local Ollama one — the rule is one rule, with no loopback exemption.
- Consent is granted **per cache key** (`sha256:providerId:model:strategy:promptVersion`) and persisted. So: approval covers that paper from any URL and survives reopening, and a request aimed at a different provider, model, strategy or prompt version asks again, because it is a different thing being sent somewhere.
- The confirmation is a **state of the outline pane**, never `window.confirm` or any other modal dialog. It states what would be sent and where: title, page count, section count (or, for a provider that chooses its own sections, that the whole paper goes — the PDF itself with its pages and size, or the extracted text — and the model chooses them; approved 2026-11-18/19), approximate token count, provider label, model id, and whether the text leaves the machine.
- **The gate is enforced in the background router**, which is the only place provider calls happen. The router reads the consent record itself and refuses an outline request that has none. A viewer that forgets to ask cannot cause a send.
- A **cache hit renders with no confirmation** — nothing leaves, so there is nothing to confirm. Likewise a scanned PDF or an empty section: no call, no card.
- **Automatic fallback may only cross to a provider with the same `destination`.** Consent is to a destination, not merely to a provider id; falling back between two models of one company is the same text going to the same company, so the original consent covers it. (Since 2026-11-18 no shipped provider falls back at all — see Provider quota accounting — but the rule stands for any that is added to `FALLBACK_ORDER`.) Reaching a different destination — notably the local model — requires its own confirmation, offered as an explicit control in the pane.

### Outline generation
- **Bullet shape depends on the provider's `promptStyle`** (changed 2026-11-18 at the user's request). `"strict"`, used by Gemma and Haiku: per section **2–4 bullets, each at most 20 words**, extractive, plus a TL;DR of at most 2 sentences. `"guidelines"`, used by Opus, Sonnet and the Gemini 4 models: loose guidance and the model's own judgement on bullet count and length, still faithful to the text, with a brief TL;DR. Under either style, each title is echoed exactly and the answer is JSON in the schema.
- Results-type sections must carry the actual reported numbers where the section states them.
- **Mathematics is LaTeX, typeset in the viewer** (2026-11-19, at the user's request). Every outline and chat prompt asks for `$…$` inline and `$$…$$` displayed; `viewer/math.js` finds those spans (prices like "$5 and $10" stay text) and renders them with KaTeX, bundled — CSS and fonts in `dist/`, nothing fetched — with `trust: false`, so no `\href`, `\url` or HTML-producing command reaches the page. TeX KaTeX cannot read is shown as written, never hidden. Plain runs between math keep the old clean-up of stray wrappers.
- The model returns JSON matching the schema in SPEC.md. Prose parsing is never a fallback; a malformed response is an error surfaced to the user.
- Every bullet carries the `page` and `y` of its section, so a bullet always has a target even when nothing better is known.
- **A bullet jumps to the lines it restates, when those can be found; to its heading when they cannot** (changed 2026-09-13 at the user's request; it used to be the heading always). The span is **derived in the viewer** by matching the bullet's words against that section's own extracted lines — see `viewer/locate.js`. Three properties are what make deriving it acceptable where asking would not be: the search is bounded to the bullet's own section, so a bad match is off by lines rather than by chapters; it is recomputed from the live extraction on every open, so no position is ever cached or migrated; and a weak match returns nothing and falls back to the heading, which is what every bullet did before. Measured over the fixtures: 99% of paraphrased passages land on their own lines, and under 1% of passages from other papers are placed at all.
- **Quote first** (2026-11-19, at the user's request). A provider that chooses its own sections also returns, per bullet, 6–15 words copied from that section; `viewer/locate-quote.js` finds them in the section's own lines (in order within twice the quote's length, ≥ 80% of the words — or ≥ 10 words and ≥ 60% when a table interrupts the sentence — tightest stretch wins; hyphen and ligature splits rejoined, Greek letters read by name) and the bullet jumps there. The word match above is the fallback, then the heading. Like a copied heading, a quote is text that is in the section or is not — never a position. Measured on the user's two papers with Opus reading the PDF: 121 of 121 bullets placed by their quote, against 71 by words alone; spot-checked, each on the sentence quoted.
- The arrival band covers only the matched lines' column (their x extent, kept on each line record), and the scroll brings that column into view when zoomed in. Every jump first remembers the reading spot; **Back** (a button over the paper, or Alt+←) returns to the spot before the first of a run of jumps.
- **No position ever comes from the model — not the section's, not a bullet's.** For a provider sent the extracted sections, `page`/`y` come from the extracted section at that index, and the model echoes each section's `title` as a checksum. For a provider that chooses its own sections (approved 2026-11-18), the model decides *where sections begin* by copying each opening line; this machine finds that line among the paper's own extracted lines, searching forward only, and takes `page`/`y` from it. A heading not found in order is kept with its bullets, marked unplaced and said so in the outline, and jumps to where the section before it begins (2026-11-19, at the user's request — one stray heading used to discard the whole outline); more than half unplaced is a malformed response. The viewer finds the lines again on every open, so nothing about where a section's lines are is cached. **Asking a model for a line number or an offset is still forbidden**: a copied line can only match the text or fail, a number can point somewhere plausible and wrong. A section-count or title mismatch, or a heading that cannot be placed, is an error surfaced to the user, not a best-effort render — a cached outline is served thereafter with no confirmation and no network request, so a slip not caught here is permanent.

### Chunking strategy is a property of the provider, not of the task
- The application calls `outline(document)` and receives sections. **It never loops over sections itself.**
- Each provider descriptor declares `strategy`:
  - `"whole-document"` — one request carrying the entire paper. Cheapest in tokens, one TL;DR written with the whole paper in context, and one request to account for. This is what every Claude and Gemini provider uses — and with `sections: "model"`, that one request is the whole paper.
  - `"per-section"` — one request per section, dispatched with bounded concurrency and streamed as each completes. Fills the pane progressively and isolates a failure to one section, at the cost of repeating the prompt per request. This is what `ollama` uses.
- Changing strategy changes the cache key, because the two produce different artifacts.

### Provider quota accounting
- A provider descriptor may declare `limits: { rpd, rpm }` and must declare a `destination` (`"google"`, `"local"`, …) — the party the text reaches. Consent and fallback are both scoped by it.
- Google's free-tier daily quota resets at **midnight US Pacific Time**, not local time. The quota day is therefore the calendar date produced by `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`, which tracks Pacific DST automatically. Counters are keyed by that string.
- When a request would exceed `rpd`, or a call returns HTTP 429, the adapter **falls back to the next provider of the same `destination` that is listed in `FALLBACK_ORDER`** rather than failing. The reader's order in settings decides which comes first, never whether a provider is an automatic target: `fallbacksFor` only ever returns ids in `FALLBACK_ORDER`. Since 2026-11-18 that list is Opus alone, so **no model is ever switched to automatically.** (A bug in step 21 let the reader's order make Sonnet and Haiku automatic targets; fixed the same day.) When the chain for that destination is exhausted, the outline pane states which provider is exhausted and when its quota resets, in Asia/Hong_Kong time, and offers any other-destination provider as an explicit choice.
- **The local model is never an automatic fallback target.** Claude Opus 5.5, through the bridge, is the default (since 2026-11-18; Gemini was the default before). A usage limit stops and offers Sonnet, Haiku, the Gemini 4 models or the local model as explicit choices. None is an automatic target: changing model is the user's call. Gemini 3 (3.8 Flash, 3.5 Flash-Lite) was removed 2026-11-18 at the user's request; Gemini 4 Argon, Carbon and Hydrogen replace it. Ollama is used only when the user selects it — in settings, or from the control the exhausted-provider message offers. This is a user preference, not an incidental consequence of the fallback list.

### Caching
- Cache key: `sha256:providerId:model:strategy:promptVersion`.
- `promptVersion` is an integer constant in the prompt module, bumped by hand whenever a prompt changes. Outlines generated by an older prompt are never served as current.
- A cache hit makes zero network requests. With a 20-requests-per-day provider this is a correctness requirement, not an optimisation.

### Chat (step 22)
- The pane has two tabs, **Outline** and **Chat**. Chat answers the reader's questions about the open paper.
- **Chat runs on every provider spoken to over the OpenAI-compatible wire**: the Claude ones through the bridge, and the Gemini 4 models with the reader's Gemini key (requests counted in the quota table). Ollama stays outline-only: its native transport has no text mode.
- **Its consent is separate from the outline's.** The key is `sha256:providerId:model:chat:CHAT_PROMPT_VERSION` (`store/cache-key.js#chatKey`). An outline approval does not cover chat. **Pressing Send is the approval** (changed 2026-11-18 at the user's request; it used to be a separate card). A line above the box always says, before the first question, that Send shares the paper (with a token estimate) and the conversation, and where: the company, the model, and whether through Claude Code or the Gemini key. Send then has the router record the grant for that paper and model, and sends. The gate is unchanged: `background/chat.js` re-reads the grant before every call, so a page that skips recording one sends nothing.
- What is sent: the same extracted text an outline sends, References already cut off, as the system prompt; earlier turns, then the question. Once an outline is on screen, chat is sent — and its § links point at — the outline's sections; before that, the extraction's.
- **The PDF itself** goes to the providers that take one (as for outlines), in the first user turn, with the sections' titles as the list to cite from; otherwise the extracted text as the system prompt. The question box empties as the question is sent and gets it back if it goes unanswered.
- **Section links in a reply:** the model cites `[§ Title]`, or `[§ Title | "exact words"]` to point at a sentence (2026-11-19) — the quote is looked for in that section's lines, and the link falls back to the heading. The viewer makes a link only when the title matches an extracted section, and jumps to *that section's* `page`/`y`. A position never comes from the model, here as everywhere.
- **New chat** (2026-11-18) clears the conversation and starts over; when there is one, the pane asks once ("Start new chat" / "Keep this one"), never with a dialog.
- The conversation is stored per document hash (IndexedDB `chats`, db version 4, last 60 messages), written only by the background, and only once a reply is whole. A failed turn leaves it unchanged.

### Reading chrome
- The viewer opens in **dark theme by default**. The toggle is per-profile in `storage.local`, not per document.
- Reading position (page and scroll offset) is stored per document hash and restored on reopen.

## Secrets policy
- **Safe to commit:** provider base URLs, model IDs, all of `providers.js` except keys. These are public constants.
- **Never in the repo or the built bundle:** the Gemini API key, and any other provider key. Keys are entered by the user in the extension's settings page and live only in `browser.storage.local`.
- `.env`, `*.key` and `dist/` are gitignored.
- **Verification gate:** before any packaging or signing step, run `npm run check:secrets`, which greps `dist/` for `AIza` (Google API key prefix) and for `sk-`. A non-empty match fails the step.

## Project values
- Extension ID (`browser_specific_settings.gecko.id`): `scholar-reader@kevin.local`
- Ollama endpoint: `http://127.0.0.1:11434`
- Claude bridge: `http://127.0.0.1:8765` (`npm run bridge`, `tools/claude-bridge.mjs`); token in `~/.config/scholar-reader/bridge-token`
- **Subscription, not API:** the Claude providers run through the local bridge on the user's Claude Code subscription login, never on an Anthropic API key. The bridge refuses to start unless `claude auth status` reports a `claude.ai` login, and it strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (and the Bedrock/Vertex switches) from the CLI's environment. Usage counts against the subscription's limits, which interactive Claude Code shares.
- Gemini OpenAI-compatible base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
- Default model: `claude-opus-5-5` (also `claude-sonnet-5-5`, `claude-haiku-5-5`) · Gemini: `gemini-4-argon`, `gemini-4-carbon`, `gemini-4-hydrogen` (Gemini 3 removed 2026-11-18) · Offline model: `gemma4:e4b`

## Working agreement (multi-session build)
- Build in the order in PROGRESS.md, one step at a time.
- After finishing each step: test it, update PROGRESS.md (tick the box, set Current/Next, note decisions or gotchas), then commit. A commit is always a working, tested state — never commit a half-finished step.
- At the start of every session: read the planning files; reconcile PROGRESS.md against `git log` and the working tree; run `npm run build` to confirm the tree is healthy before continuing. If sources disagree, trust git + working tree over PROGRESS.md, and fix PROGRESS.md.
- Steps marked ⏸️ require the user: stop, give exact instructions, wait for confirmation and any values produced.
- Only stop to ask otherwise when: a command needs approval, an error survives a real fix attempt, or the final hand-back step is reached.
