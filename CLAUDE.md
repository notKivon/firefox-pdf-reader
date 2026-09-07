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

### Outline generation
- Output is always: per section, **2–4 bullets, each at most 20 words**, extractive — restating what the section says, never inferring beyond it. Plus one whole-document TL;DR of at most 2 sentences.
- Results-type sections must carry the actual reported numbers where the section states them.
- The model returns JSON matching the schema in SPEC.md. Prose parsing is never a fallback; a malformed response is an error surfaced to the user.
- Every bullet carries the `page` and `y` of its section so the viewer can scroll to it.

### Chunking strategy is a property of the provider, not of the task
- The application calls `outline(document)` and receives sections. **It never loops over sections itself.**
- Each provider descriptor declares `strategy`:
  - `"whole-document"` — one request carrying the entire paper. Required when a provider has a low requests-per-day cap.
  - `"per-section"` — one request per section, streamed as each completes. For providers billed per token with no meaningful request cap.
- Changing strategy changes the cache key, because the two produce different artifacts.

### Provider quota accounting
- A provider descriptor may declare `limits: { rpd, rpm }`.
- Google's free-tier daily quota resets at **midnight US Pacific Time**, not local time. The quota day is therefore the calendar date produced by `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`, which tracks Pacific DST automatically. Counters are keyed by that string.
- When a request would exceed `rpd`, or a call returns HTTP 429, the adapter **falls back to the next configured provider** rather than failing. If no fallback is configured, the outline pane states which provider is exhausted and when its quota resets, in Asia/Hong_Kong time.

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
