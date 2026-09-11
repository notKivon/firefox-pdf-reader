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
PROGRESS.md, one step at a time, committing only tested working states.
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

## Loading into Zen

Zen enforces Gecko's extension signature requirement and its
`xpinstall.signatures.required` pref cannot be overridden, so during development
the extension is loaded temporarily and **is lost on every browser restart**.

1. `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → select `dist/manifest.json`
4. Reload after each rebuild with the **Reload** button on the extension's card

Permanent installation requires AMO *unlisted* signing — that's step 16, and it's
only worth doing once the extension is stable, since each release needs another
round trip.

## Commands

These exist from step 1 onward.

| | |
|---|---|
| `npm run build` | Bundle to `dist/` |
| `npm run watch` | Rebuild on change |
| `npm run check:secrets` | Fail if `dist/` contains an API key. Run before any packaging or signing step. |

## Secrets

No API key ever goes in this repo. Keys are entered in the extension's own
settings page and live in `browser.storage.local`. See the secrets policy in
`CLAUDE.md`.

`.gitignore` covers the paths a key could plausibly reach: `dist/`, `.env`,
`*.key`, `*.xpi`. `npm run check:secrets` greps the **built bundle**, which is
the case that matters before packaging — but note it does not scan tracked
sources, so a key pasted into a source file or a fixture would slip past it.
On a public repo that is unrecoverable by deletion: a pushed key must be
treated as burned and rotated at aistudio.google.com, not just removed.

Worth tightening at step 14, when `settings.js` starts handling the key for
real and a stray `console.log` becomes the likely slip.
