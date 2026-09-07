# Scholar Reader — Build Progress

**Current step:** 1 — Scaffold and loadable extension shell
**Next step:** 2 — PDF interception and pdf.js viewer
**Last verified healthy:** not yet built

## Checklist

- [ ] 1. **Scaffold and loadable extension shell** — `npm init`, `esbuild.config.mjs`, `manifest.json` (MV3 Firefox flavour, gecko id, `unlimitedStorage`), directory layout from SPEC.md, `.gitignore`, `tools/check-secrets.mjs` + `npm run check:secrets`. Background script and `viewer.html` exist but do nothing beyond logging. *Verify:* `npm run build` emits `dist/`; the extension loads in Zen via `about:debugging` with no console errors.
- [ ] 2. **PDF interception and pdf.js viewer** — `intercept.js` per CLAUDE.md, bundled `pdfjs-dist` `PDFViewer` in `pdfview.js`, dark theme tokens in `theme.css`, two-pane shell with an empty right pane. *Verify:* an arXiv PDF link opens in the custom viewer, renders, and scrolls smoothly; the viewer is dark on first open.
- [ ] 3. ⏸️ **Google AI Studio key and real rate limits** — user creates an API key at aistudio.google.com, then opens the AI Studio rate-limit page and reports the **actual** RPD and RPM shown for `gemini-3.8-flash` and `gemini-3.5-flash-lite`. Update `limits` in `src/model/providers.js` with the real numbers; the values currently in SPEC.md are placeholders. The key itself is entered in extension settings later and must never be written into the repo.
- [ ] 4. **Document identity and IndexedDB store** — `store/db.js`, `docs.js`, sha256 of PDF bytes, reading-position save/restore. *Verify:* reopening a PDF returns to the previous scroll position; the same paper from two different URLs produces one `docs` record.
- [ ] 5. **Text layer and column detection** — `extract/textlayer.js`, `extract/columns.js`, plus a debug panel in the right pane showing detected columns and reading order. *Verify:* reading order is correct on three two-column papers and two single-column ones.
- [ ] 6. **Heading detection and section assembly** — `extract/sections.js`, `getOutline()` path, heuristic path, References cutoff, scanned-PDF detection, the chunked fallback. Save each tested paper's extracted sections to `fixtures/`. *Verify:* the debug panel lists correct sections for ten papers off the reading list; a scanned PDF reports itself as scanned and makes no model call.
- [ ] 7. **Provider adapter and Gemini development tier** — `model/providers.js`, `adapter.js`, `openai-compat.js`, `prompts.js`, `background/router.js` message path. Develop against `gemini-dev` (`per-section`), because iterating prompts on a 20-request daily budget is not workable. *Verify:* a fixture in, valid schema-conformant outline JSON out, no PDF in the loop.
- [ ] 8. **Outline pane and section jumping** — render sections and bullets, click-to-jump via `scrollPageIntoView`, highlight flash on arrival, scroll-spy highlighting the current section, progressive fill as sections resolve. *Verify:* end-to-end on a real paper; every bullet jumps to the right place.
- [ ] 9. **Cache, quota accounting and 429 fallback** — `store/outlines.js`, `store/quota.js`, cache key per CLAUDE.md, Pacific-date quota counter, automatic fallback on exhaustion or 429. *Verify:* reopening a document issues zero network requests; a stubbed 429 falls through to the next provider; a stubbed date change resets the counter.
- [ ] 10. ⏸️ **Ollama and Gemma 4 E4B** — user installs Ollama, runs `ollama pull gemma4:e4b`, and starts the server with `OLLAMA_ORIGINS="moz-extension://*" ollama serve`. Report back that `curl http://127.0.0.1:11434/api/tags` responds.
- [ ] 11. **Ollama provider implementation** — second implementation behind the same adapter; specific detection and remedy message for a refused `Origin`. *Verify:* the same paper outlines with the network off, changing only the provider selection. This step is what proves the adapter is a real abstraction rather than a wrapper around one API.
- [ ] 12. **Switch to the production provider** — make `gemini-prod` the default with `whole-document` strategy; confirm one request per paper and that streaming still fills the pane progressively. *Verify:* opening a fresh paper increments the quota counter by exactly 1.
- [ ] 13. **Hardening and settings** — `settings.html` (key entry, provider order, origin opt-out), escape hatch to Firefox's own viewer, `file://` open-local-file control, error states on every async path. *Verify:* every failure mode in CLAUDE.md produces a readable message rather than a spinner.
- [ ] 14. **Final hand-back** — `npm run check:secrets` passes; a fresh clone builds and loads; README records the `about:debugging` load procedure.
- [ ] 15. ⏸️ **AMO unlisted signing (post-v1)** — user submits the XPI to addons.mozilla.org as *unlisted*, downloads the signed file, installs it permanently in Zen. Only worth doing once the extension is stable, since each release needs a new round trip.

## Deferred past v1
Quota meter UI and model dropdown (step 9 gives the accounting and automatic fallback; the on-screen `n/20 today` readout and manual model selector are a later addition). Fit modes, keyboard navigation. Figure and table popups, inline citation previews — both cut from scope deliberately.

## Decisions & gotchas
- 2026-09-07 — Tier 3 build: the Gemini API key is a real secret, and there are three external dependencies (Gemini, Ollama, AMO).
- 2026-09-07 — Chunking strategy is a provider property, not a global constant. The 20-requests-per-day free tier forces `whole-document`; a per-token provider would prefer `per-section`. Callers must never loop over sections themselves or this leaks upward and makes provider swaps into refactors.
- 2026-09-07 — All provider calls happen in the background script. Extension background fetches for hosts in `host_permissions` bypass CORS; Gemini's endpoints do not reliably send CORS headers, so calling from the viewer page would fail.
- 2026-09-07 — Develop on `gemini-3.5-flash-lite` (higher daily cap), ship on `gemini-3.8-flash`. Prompt iteration on 20 requests/day would consume a day's budget in three runs. Fixtures in `fixtures/` exist so prompts can be iterated without re-parsing PDFs.
- 2026-09-07 — Google's free-tier daily quota resets at midnight US Pacific, not local time, so the counter is keyed by the Pacific calendar date rather than a local one.
- 2026-09-07 — Zen cannot install unsigned extensions; `xpinstall.signatures.required` is locked in its default profile config with no Zen-side override. Development is `about:debugging` (temporary, lost on restart); permanent installation requires AMO unlisted signing.
- 2026-09-07 — Section extraction from two-column PDFs is the highest-risk part of this build. Steps 5 and 6 are deliberately separate and both end in a visible debug panel, so failures are diagnosable rather than mysterious.
