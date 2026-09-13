// The right-hand pane and the states it moves through: the confirm card, the
// progressive fill, the finished outline, and the error paths.
//
// The order of the send is the whole point of the first three: `plan` first —
// which makes no network request — then the card, then the grant, and only then
// the send. Rendering the outline itself belongs to `outline-list.js`.
import { confirmCard } from "./confirm-card.js";
import { el } from "./el.js";
import { errorBox } from "./pane-error.js";
import { outlineList } from "./outline-list.js";
import { providerSwitch } from "./provider-switch.js";
import { grantConsent } from "../store/consent.js";

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
  let list = null; // the rendered outline, while one is on screen

  // Every state change drops the outline, so the spy is told before anything can
  // ask it to highlight a section that is no longer rendered.
  const show = (...nodes) => {
    list = null;
    onSections?.([]);
    root.replaceChildren(...nodes);
  };

  function showMessage(text, className = "pane-placeholder") {
    show(el("p", className, text));
  }

  // Every failure state, including the ones the reader can be stranded in: see
  // pane-error.js for why the alternatives travel with them.
  function showError(text, { retry, plan } = {}) {
    show(errorBox(text, { retry, plan, onPickProvider: (id) => replan(id).catch(reportFailure) }));
  }

  // The finished outline. It names `result.model` rather than the provider that
  // was asked: fallback may have moved the run, and the reader should see who
  // actually answered. A cache hit says so too — it is the reader's evidence
  // that this open sent nothing anywhere.
  function showReady(result) {
    const rendered = outlineList(result, {
      onJump,
      // Located from the live extraction every open, so a cached outline needs
      // no migration and nothing about a bullet's position is ever stored.
      linesFor: (index) => current?.sections?.[index]?.lines,
    });
    const box = el("div", "outline-ready");
    box.append(rendered.node);
    if (result.model) {
      const source = result.cacheHit
        ? `Outlined by ${result.model}, from this document's cache — nothing was sent.`
        : `Outlined by ${result.model}.`;
      box.append(el("p", "outline-source", source));
    }
    // Non-fatal: the outline is on screen either way, and the only consequence
    // is another run next time. Saying so beats silence.
    if (result.warning) box.append(el("p", "pane-note", result.warning));
    // A finished outline is not the end of the reader's choices. Re-planning
    // under another model is a different cache key, so it renders from that
    // model's cache if it has one and asks for its own confirmation if not —
    // crossing to the local model included.
    const switcher = providerSwitch(current?.plan, (id) => replan(id).catch(reportFailure));
    if (switcher) box.append(switcher);
    show(box);
    list = rendered;
    onSections?.(rendered.targets);
    onReady?.();
  }

  async function replan(providerId) {
    current = { ...current, providerId };
    showMessage("Working out what would be sent…");
    const detail = await browser.runtime.sendMessage({
      type: "plan",
      hash: current.hash,
      sections: forSending(current.sections),
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
  // that is not remembered is not the consent CLAUDE.md specifies.
  async function confirm(detail) {
    showMessage("Starting…");
    try {
      await grantConsent(detail);
    } catch (err) {
      console.error("[scholar-reader] consent not stored", err);
      showError(`Your approval could not be stored, so nothing was sent: ${err.message}`, {
        retry: () => confirm(detail),
        plan: detail,
      });
      return;
    }
    await send(detail);
  }

  async function send(detail) {
    // Kept for the progress line, which replaces this message as soon as the
    // first section lands and should still say who is writing it.
    current = { ...current, label: detail.label };
    showMessage(`Generating outline with ${detail.label}…`);
    const result = await browser.runtime.sendMessage({
      type: "outline",
      hash: current.hash,
      sections: forSending(current.sections),
      meta: current.meta,
      providerId: detail.providerId,
    });
    // The router refused: either the grant never landed or this is a different
    // key than the one granted. Either way the card, not an error, is the answer.
    if (result?.error === "consent-required") {
      return show(
        confirmCard(result.plan, {
          onConfirm: () => confirm(result.plan),
          onPickProvider: (id) => replan(id).catch(reportFailure),
        }),
      );
    }
    if (result?.error) {
      return showError(result.message ?? "The outline could not be generated.", {
        retry: () => send(detail).catch(reportFailure),
        plan: detail,
      });
    }
    showReady(result);
  }

  function reportFailure(err) {
    console.error("[scholar-reader] outline pane failed", err);
    showError(String(err?.message ?? err));
  }

  // Progressive fill, under either strategy: the sections that have landed are
  // rendered and clickable straight away, with the rest still to come. The
  // router also sends a bare `{providerId}` when fallback moves the run, which
  // carries no sections and is not a render.
  function progress(partial) {
    if (partial.hash !== current?.hash || !partial.sections?.length) return;
    const rendered = outlineList({ sections: partial.sections }, { onJump, partial: true });
    const box = el("div", "outline-live");
    box.append(
      el("p", "pane-placeholder", `Generating outline with ${current.label ?? "the model"}…`),
      rendered.node,
    );
    show(box);
    list = rendered;
    onSections?.(rendered.targets);
  }

  // Driven by the scroll-spy; a no-op in every state but a rendered outline.
  function setActive(index) {
    list?.setActive(index);
  }

  /** @param {{hash, sections, meta, scanned}} doc the extraction result */
  function start({ hash, sections, meta, scanned }) {
    current = { hash, sections, meta };
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
