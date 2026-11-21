// The right-hand pane and the states it moves through: the confirm card, the
// progressive fill, the finished outline, and the error paths.
//
// The order of the send is the whole point of the first three: `plan` first —
// which makes no network request — then the card, then the grant, and only then
// the send. Rendering the outline itself belongs to `outline-list.js`.
import { ask } from "./ask.js";
import { confirmCard } from "./confirm-card.js";
import { describeFailure } from "./diagnostics.js";
import { el } from "./el.js";
import { errorBox } from "./pane-error.js";
import { outlineList } from "./outline-list.js";
import { outlineProgress } from "./outline-progress.js";
import { readyBox } from "./outline-ready.js";
import { paperForSending, pdfInfoOf, resolvedSections } from "./outline-sections.js";
import { shortName } from "./provider-switch.js";

// Sections carry their body lines so a bullet can be located against the paper
// (locate.js). Those lines never leave this page: the router builds the model
// payload from `text`, and sending them would put the same words on the wire
// twice for nothing. Stripped explicitly, at the one boundary, rather than by
// convention — `outline-pane.test.mjs` asserts no outbound message carries them.
const forSending = (sections) => sections.map(({ lines, ...rest }) => rest);
/**
 * @param {object} args
 * @param {HTMLElement} args.root
 * @param {(target: {page, y}) => void} [args.onJump] scrolls the paper
 * @param {(targets: {page, y}[]) => void} [args.onSections] hands the scroll-spy
 *   the jump targets currently on screen — an empty list whenever there are none
 * @param {() => void} [args.onReady] a finished outline is on screen, fresh or cached
 */
export function createOutlinePane({ root, onJump, onSections, onReady }) {
  let current = null; // {hash, sections, meta, providerId, label}
  let granted = null; // the cache key this page last had the router record
  let list = null; // the rendered outline, while one is on screen
  let live = null; // {progress, host} while a run is in flight

  // Every state change drops the outline, so the spy is told before anything can
  // ask it to highlight a section that is no longer rendered.
  const show = (...nodes) => {
    live?.progress.dispose();
    live = null;
    list = null;
    onSections?.([]);
    root.replaceChildren(...nodes);
  };

  function showMessage(text, className = "pane-placeholder") {
    show(el("p", className, text));
  }

  // Every failure state, including the ones the reader can be stranded in: see
  // pane-error.js for why the alternatives travel with them.
  function showError(text, { retry, plan, details, retryLabel, calm } = {}) {
    show(errorBox(text, { retry, plan, details, retryLabel, calm, onPickProvider: (id) => replan(id).catch(reportFailure) }));
  }

  // The finished outline, fresh or cached: see outline-ready.js.
  function showReady(result) {
    const resolved = resolvedSections(result, current);
    const { node, rendered } = readyBox(result, {
      onJump,
      linesFor: (index) => resolved?.[index]?.lines,
      plan: current?.plan,
      onPickProvider: (id) => replan(id).catch(reportFailure),
    });
    show(node);
    list = rendered;
    onSections?.(rendered.targets);
    onReady?.(resolved);
  }

  async function replan(providerId) {
    current = { ...current, providerId };
    showMessage("Working out what would be sent…");
    const detail = await browser.runtime.sendMessage({
      type: "plan",
      hash: current.hash,
      sections: forSending(current.sections),
      paper: paperForSending(current.paper),
      pdfInfo: pdfInfoOf(current.pdf),
      meta: current.meta,
      providerId,
    });
    if (detail?.error) {
      showError(detail.message ?? "The outline could not be planned.");
      return;
    }
    // A cache hit renders with no confirmation — nothing leaves, so there is
    // nothing to confirm (CLAUDE.md), and no request is made to find out.
    current = { ...current, plan: detail };
    if (detail.cacheHit) return showReady({ ...detail.outline, cacheHit: true });
    if (detail.consented) return send(detail);
    show(
      confirmCard(detail, {
        onConfirm: () => confirm(detail),
        onPickProvider: (id) => replan(id).catch(reportFailure),
      }),
    );
  }

  // The grant is written before anything is sent, so a crash mid-request cannot
  // lose it and ask again. If it cannot be written, nothing is sent: a consent
  // that is not remembered is not the consent CLAUDE.md specifies. The router
  // writes it, not this page: a reader tab in a container has its own partition
  // of IndexedDB, and a grant written there is one the gate never sees.
  async function confirm(detail) {
    showMessage("Starting…");
    try {
      await ask({ type: "grant", hash: detail.hash, providerId: detail.providerId, cacheKey: detail.cacheKey });
      granted = detail.cacheKey;
    } catch (err) {
      console.error("[scholar-reader] consent not stored", err);
      showError(`Your approval could not be stored, so nothing was sent: ${err.message}`, {
        retry: () => confirm(detail),
        plan: detail,
        details: await describeFailure({ "Approving": detail.cacheKey, "Error": String(err?.message ?? err) }),
      });
      return;
    }
    await send(detail);
  }

  async function send(detail) {
    current = { ...current, label: detail.label };
    // The run's own state, live: stage, time, silence, and Stop. Sections fill
    // in beneath it as they land (progress below).
    const hash = current.hash;
    const progress = outlineProgress({
      label: shortName(detail.label),
      pdf: Boolean(detail.pdf),
      onStop: () => browser.runtime.sendMessage({ type: "outline-stop", hash }).catch(reportFailure),
    });
    const host = el("div", "outline-live-list");
    const box = el("div", "outline-live");
    box.append(progress.node, host);
    show(box);
    live = { progress, host };
    const result = await browser.runtime.sendMessage({
      type: "outline",
      hash: current.hash,
      sections: forSending(current.sections),
      paper: paperForSending(current.paper),
      pdf: current.pdf ?? undefined,
      meta: current.meta,
      providerId: detail.providerId,
    });
    // The router refused. Straight after this page's own approval of the same
    // key, that is a fault — the grant did not land where the gate reads — and
    // redrawing the card would look like a flicker with nothing to say why. Any
    // other key is a different send, and the card is the answer.
    if (result?.error === "consent-required" && result.plan?.cacheKey === granted) {
      console.error("[scholar-reader] refused straight after approval", result);
      return showError("Your approval was saved, but the background still found no approval for this send, so nothing was sent.", {
        retry: () => confirm(detail).catch(reportFailure),
        plan: detail,
        details: await describeFailure({ "Approved": granted, "Router checked": result.plan.cacheKey, "Reply": result }),
      });
    }
    if (result?.error === "consent-required") {
      return show(
        confirmCard(result.plan, {
          onConfirm: () => confirm(result.plan),
          onPickProvider: (id) => replan(id).catch(reportFailure),
        }),
      );
    }
    // The reader's own Stop: not a failure, and nothing to diagnose.
    if (result?.error === "cancelled") {
      return showError(result.message ?? "Stopped.", {
        retry: () => send(detail).catch(reportFailure),
        retryLabel: "Generate outline",
        plan: detail,
        calm: true,
      });
    }
    if (result?.error) {
      return showError(result.message ?? "The outline could not be generated.", {
        retry: () => send(detail).catch(reportFailure),
        plan: detail,
        details: await describeFailure({ "Sending": detail.cacheKey, "Reply": result }),
      });
    }
    showReady(result);
  }

  function reportFailure(err) {
    console.error("[scholar-reader] outline pane failed", err);
    const text = String(err?.message ?? err);
    showError(text);
    // Filled in once known; the message is on screen either way.
    describeFailure({ "Error": text, "Stack": err?.stack })
      .then((details) => showError(text, { details }))
      .catch(() => {});
  }

  // The run's news, under either strategy: a stage, a sign of life, or the
  // sections that have landed — rendered and clickable straight away, with the
  // rest still to come. A bare `{providerId}` (fallback moved the run) is life.
  function progress(partial) {
    if (partial.hash !== current?.hash || !live) return;
    live.progress.update(partial);
    if (!partial.sections?.length) return;
    const rendered = outlineList({ sections: partial.sections }, { onJump, partial: true });
    live.host.replaceChildren(rendered.node);
    list = rendered;
    onSections?.(rendered.targets);
  }

  // Driven by the scroll-spy; a no-op in every state but a rendered outline.
  function setActive(index) {
    list?.setActive(index);
  }

  /** @param {{hash, sections, meta, scanned, paper}} doc the extraction result */
  function start({ hash, sections, meta, scanned, paper, pdf }) {
    current = { hash, sections, meta, paper, pdf };
    // No call, no card: a scanned PDF and an empty extraction both have nothing
    // to send, so neither asks (CLAUDE.md).
    if (scanned) {
      return showMessage(
        "This looks like a scanned PDF — there is no text layer to outline, and nothing was sent. OCR is out of scope.",
      );
    }
    if (!sections.some((section) => section.text.trim())) {
      return showMessage("No section text could be extracted from this document, so there is nothing to outline.");
    }
    replan(undefined).catch(reportFailure);
  }

  // Extraction failed upstream. Not a spinner, not silence.
  function fail(text) {
    showError(text);
  }

  showMessage("Waiting for the text layer…");
  return { start, progress, fail, setActive };
}
