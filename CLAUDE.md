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
- On match, redirect to `viewer.html?file=<encodeURIComponent(originalUrl)>`.
- Firefox only permits redirecting `http:` and `https:` requests. `file://` PDFs are opened through an explicit "Open local file" control in the viewer instead.
- A per-origin opt-out list in settings suppresses interception for listed hosts.

### Section extraction
- If `pdfDoc.getOutline()` returns bookmarks, those are the sections and heuristics are skipped.
- Otherwise sections are derived from the text layer (see SPEC.md for the algorithm).
- Extraction **stops at the References/Bibliography heading**. Reference lists are never sent to a model.
- A document whose extracted text is under 200 characters per page on average is treated as a **scanned PDF**: the outline pane says so plainly and no model call is made. OCR is out of scope.
- Hard cap of 40 sections per document.

### Send confirmation (no document reaches a model unasked)
- **No document's text is sent to any model until the user confirms it for that document.** This holds for every provider, including the local Ollama one — the rule is one rule, with no loopback exemption.
- Consent is granted **per cache key** (`sha256:providerId:model:strategy:promptVersion`) and persisted. So: approval covers that paper from any URL and survives reopening, and a request aimed at a different provider, model, strategy or prompt version asks again, because it is a different thing being sent somewhere.
- The confirmation is a **state of the outline pane**, never `window.confirm` or any other modal dialog. It states what would be sent and where: title, page count, section count, approximate token count, provider label, model id, and whether the text leaves the machine.
- **The gate is enforced in the background router**, which is the only place provider calls happen. The router reads the consent record itself and refuses an outline request that has none. A viewer that forgets to ask cannot cause a send.
- A **cache hit renders with no confirmation** — nothing leaves, so there is nothing to confirm. Likewise a scanned PDF or an empty section: no call, no card.
- **Automatic fallback may only cross to a provider with the same `destination`.** Consent is to a destination, not merely to a provider id; falling back from `gemini-prod` to `gemini-dev` is the same text going to the same company, so the original consent covers it. Reaching a different destination — notably the local model — requires its own confirmation, offered as an explicit control in the pane.

### Outline generation
- Output is always: per section, **2–4 bullets, each at most 20 words**, extractive — restating what the section says, never inferring beyond it. Plus one whole-document TL;DR of at most 2 sentences.
- Results-type sections must carry the actual reported numbers where the section states them.
- The model returns JSON matching the schema in SPEC.md. Prose parsing is never a fallback; a malformed response is an error surfaced to the user.
- Every bullet carries the `page` and `y` of its section so the viewer can scroll to it.
- **`page`/`y` come from the extracted section at that index, never from the model.** The model echoes each section's `title`, which is compared against the input title as a checksum. A section-count or title mismatch is a malformed response — an error surfaced to the user, not a best-effort render. Misaligned bullets would scroll to the wrong place with nothing to indicate it, and a cached outline is served thereafter with no confirmation and no network request, so a slip that is not caught here is permanent.

### Chunking strategy is a property of the provider, not of the task
- The application calls `outline(document)` and receives sections. **It never loops over sections itself.**
- Each provider descriptor declares `strategy`:
  - `"whole-document"` — one request carrying the entire paper. Cheapest in tokens, one TL;DR written with the whole paper in context, and one request to account for. This is what `gemini-prod` uses.
  - `"per-section"` — one request per section, dispatched with bounded concurrency and streamed as each completes. Fills the pane progressively and isolates a failure to one section, at the cost of repeating the prompt per request. This is what `gemini-dev` and `ollama` use.
- Changing strategy changes the cache key, because the two produce different artifacts.

### Provider quota accounting
- A provider descriptor may declare `limits: { rpd, rpm }` and must declare a `destination` (`"google"`, `"local"`, …) — the party the text reaches. Consent and fallback are both scoped by it.
- Google's free-tier daily quota resets at **midnight US Pacific Time**, not local time. The quota day is therefore the calendar date produced by `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`, which tracks Pacific DST automatically. Counters are keyed by that string.
- When a request would exceed `rpd`, or a call returns HTTP 429, the adapter **falls back to the next configured provider of the same `destination`** rather than failing. When the chain for that destination is exhausted, the outline pane states which provider is exhausted and when its quota resets, in Asia/Hong_Kong time, and offers any other-destination provider as an explicit choice.
- **The local model is never an automatic fallback target.** Gemini is the default and serves every automatic path; Ollama is used only when the user selects it — in settings, or from the control the exhausted-provider message offers. This is a user preference, not an incidental consequence of the fallback list.

### Caching
- Cache key: `sha256:providerId:model:strategy:promptVersion`.
- `promptVersion` is an integer constant in the prompt module, bumped by hand whenever a prompt changes. Outlines generated by an older prompt are never served as current.
- A cache hit makes zero network requests. With a 20-requests-per-day provider this is a correctness requirement, not an optimisation.

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
- Gemini OpenAI-compatible base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
- Production model: `gemini-3.8-flash` · Development model: `gemini-3.5-flash-lite` · Offline model: `gemma4:e4b`

## Working agreement (multi-session build)
- Build in the order in PROGRESS.md, one step at a time.
- After finishing each step: test it, update PROGRESS.md (tick the box, set Current/Next, note decisions or gotchas), then commit. A commit is always a working, tested state — never commit a half-finished step.
- At the start of every session: read the planning files; reconcile PROGRESS.md against `git log` and the working tree; run `npm run build` to confirm the tree is healthy before continuing. If sources disagree, trust git + working tree over PROGRESS.md, and fix PROGRESS.md.
- Steps marked ⏸️ require the user: stop, give exact instructions, wait for confirmation and any values produced.
- Only stop to ask otherwise when: a command needs approval, an error survives a real fix attempt, or the final hand-back step is reached.
