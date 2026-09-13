# Scholar Reader

A Firefox/Zen extension that replaces the browser's PDF viewer with a two-pane academic reader: paper on the left, AI-generated section outline on the right.

**Planning files — read all three at the start of every session:**
- `CLAUDE.md` — what must be true (tech stack, code rules, domain logic, secrets policy)
- `SPEC.md` — how to build it (file-by-file responsibilities, algorithms, verification)
- `PROGRESS.md` — where the build is, and what's next

This README holds only the things that live nowhere else: the session prompts and the load procedure.

## Repository

<https://github.com/notKivon/firefox-pdf-reader> — **public**, `main` is the only
branch, and the local clone tracks `origin/main`.

Public is deliberate. Nothing here is secret: provider base URLs, model IDs and
rate limits are all public constants, and the one real secret — the Gemini API
key — is entered in the extension's settings page and never touches the repo.
It does mean history is permanent and world-readable, so the secrets policy
below is a hard rule rather than tidiness.

---

## Session prompts

### Starting a session

```
Resume the build. Read CLAUDE.md, SPEC.md, and PROGRESS.md. Reconcile
PROGRESS.md against git log and the working tree — trust git over
PROGRESS.md and fix PROGRESS.md if they disagree. Run npm run build to
confirm the tree is healthy. Then continue from the current step in
PROGRESS.md, one step at a time, committing only tested working states. After finishing a step, await further input. Do not move onto the next step without explicit user permission.
```

### After a session was cut off mid-step

```
The previous session was cut off mid-step. Do NOT modify any files yet.
First: read CLAUDE.md / SPEC.md / PROGRESS.md, run git status and git diff,
and report exactly what state the tree is in — which step was in progress,
what's done, what's untested. Then recommend one of: (a) discard uncommitted
changes and redo the step cleanly, or (b) finish and test the step from where
it stopped. Wait for my choice before touching anything.
```

### Changing the spec

A new feature or a changed rule is its own step, never a casual mid-build edit.

```
This is a spec change, not a build step. Update CLAUDE.md (and SPEC.md if the
implementation approach changes) to reflect: <the change>. Commit that on its
own. Then add the resulting build steps to PROGRESS.md and stop — I'll start
the implementation in the next step.
```

---

## From a fresh clone

Built and verified this way on Node 22 / npm 10:

```
git clone https://github.com/notKivon/firefox-pdf-reader.git
cd firefox-pdf-reader
npm ci
npm run build          # emits dist/ — the loadable extension
npm test               # no network, no key, no browser needed
npm run check:secrets
```

## Loading into Zen

Zen enforces Gecko's extension signature requirement and its
`xpinstall.signatures.required` pref cannot be overridden, so during development
the extension is loaded temporarily and **is lost on every browser restart**.

1. `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → select `dist/manifest.json`
4. Reload after each rebuild with the **Reload** button on the extension's card

Then, once per profile:

5. Open settings — the ⚙ in the viewer toolbar, or `about:addons` → Scholar Reader
   → Preferences — and paste the Gemini API key. It is stored in
   `browser.storage.local` for that profile. A browser restart removes a
   temporary add-on, and Firefox may clear its storage along with it. The user
   found no problem after a restart on 2026-09-13. If settings ever shows no key
   after a restart, enter it again.
6. **Only for the local model:** Ollama checks the request's `Origin`. With the
   macOS desktop app, run `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"` and
   restart Ollama. This does not survive a reboot. If Ollama was started from a
   shell with `ollama serve`, export the variable in that shell instead.

Permanent installation requires AMO *unlisted* signing. See below.

## Signing a release (AMO, unlisted)

1. Bump `version` in **both** `manifest.json` and `package.json`. AMO rejects a
   version it has already signed. Commit.
2. `npm run package`. This writes `web-ext-artifacts/scholar-reader-<version>.xpi`
   and `scholar-reader-<version>-source.zip`. The second file is `git archive HEAD`.
3. On <https://addons.mozilla.org/developers/addon/submit/distribution>, choose
   **On your own**, which is unlisted, and upload the `.xpi`.
4. When asked whether source code is needed, answer **Yes** and upload the
   source zip, because `dist/` is bundled by esbuild. Paste the reviewer notes
   below.
5. Once it is signed, download the signed `.xpi` from Developer Hub → the add-on →
   **Manage Status & Versions** → the version. In Zen,
   remove the temporary copy from `about:debugging` if it is loaded, then go to
   `about:addons` → ⚙ → **Install Add-on From File…**.

Reviewer notes:

```
Build: Node 22, npm 10. In the source archive: `npm ci && npm run build`.
The extension is the resulting dist/ directory, which matches the uploaded XPI
file for file. esbuild bundles without minifying. The only third-party runtime
code is pdfjs-dist (see package-lock.json); its worker, cmaps, fonts and wasm
are copied unmodified from node_modules/pdfjs-dist. The web-ext lint warnings
all come from that pdf.js code.
Data: the text of the open PDF is sent to Google's Gemini API (key supplied by
the user) or to a local Ollama server only after the user confirms each
document in the page. No data goes to the developer.
```


## Commands

| | |
|---|---|
| `npm run build` | Bundle to `dist/` |
| `npm run watch` | Rebuild on change |
| `npm test` | Unit and integration tests in Node, against stubs — no network |
| `npm run package` | Build, secrets gate, lint, then write the XPI and its source archive to `web-ext-artifacts/`. Refuses an uncommitted tree. |
| `npm run check:secrets` | Fail if `dist/` or any tracked file contains an API key. Run before any packaging or signing step. |
| `npm run probe` | Send one fixture to a real provider and report outline quality — spends real quota; see PROGRESS.md |

## Secrets

No API key ever goes in this repo. Keys are entered in the extension's own
settings page and live in `browser.storage.local`. See the secrets policy in
`CLAUDE.md`.

`.gitignore` covers the paths a key could plausibly reach: `dist/`, `.env`,
`*.key`, `*.xpi`. `npm run check:secrets` scans two things. It checks the
**built bundle** for anything key-shaped, which is what matters before
packaging. It also checks **every tracked file** for full-length keys, since
the tests use short fake ones on purpose. It cannot see a key that was never
`git add`ed, and it runs only when invoked. On a public repo, a pushed key
cannot be fixed by deleting it: treat it as burned and rotate it at
aistudio.google.com.
