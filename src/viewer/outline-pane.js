// The right-hand pane. Step 8 gives it the states around the send: the confirm
// card, the progress line, and the error paths. Step 9 replaces `showReady` with
// the real section-and-bullet rendering and the click-to-jump wiring.
//
// The order here is the whole point of the step: `plan` first — which makes no
// network request — then the card, then the grant, and only then the send.
import { confirmCard } from "./confirm-card.js";
import { grantConsent } from "../store/consent.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createOutlinePane({ root }) {
  let current = null; // {hash, sections, meta, providerId}

  const show = (...nodes) => root.replaceChildren(...nodes);

  function showMessage(text, className = "pane-placeholder") {
    show(el("p", className, text));
  }

  // CLAUDE.md: a failed model call must never leave the pane in a silent
  // spinner, so every failure lands here, in words, with a way forward.
  //
  // The way forward includes the other destinations. The card carries them too,
  // but the card is only ever shown once per cache key — after the grant it
  // never returns, so without this an error would strand the reader on the one
  // provider that just failed. It is also what CLAUDE.md requires of an
  // exhausted chain: state the problem and *offer* the other destination, as a
  // choice, never as an automatic fallback.
  function showError(text, { retry, plan } = {}) {
    const box = el("div", "outline-error");
    box.append(el("p", "pane-error", text));
    if (retry) {
      const button = el("button", "confirm-go", "Try again");
      button.type = "button";
      button.addEventListener("click", retry);
      box.append(button);
    }
    if (plan?.alternatives?.length) {
      const alt = el("div", "confirm-alt");
      alt.append(el("span", "confirm-alt-label", "Or send it somewhere else:"));
      for (const other of plan.alternatives) {
        const button = el("button", "confirm-alt-go", other.label);
        button.type = "button";
        button.addEventListener("click", () => replan(other.id).catch(reportFailure));
        alt.append(button);
      }
      box.append(alt);
    }
    show(box);
  }

  function showReady(result) {
    const bullets = result.sections.reduce((n, section) => n + section.bullets.length, 0);
    const box = el("div", "outline-ready");
    if (result.tldr) box.append(el("p", "outline-tldr", result.tldr));
    box.append(
      el("p", "pane-placeholder", `${result.sections.length} sections, ${bullets} bullets from ${result.model}.`),
    );
    show(box);
  }

  async function replan(providerId) {
    current = { ...current, providerId };
    showMessage("Working out what would be sent…");
    const detail = await browser.runtime.sendMessage({
      type: "plan",
      hash: current.hash,
      sections: current.sections,
      meta: current.meta,
      providerId,
    });
    if (detail?.error) {
      showError(detail.message ?? "The outline could not be planned.");
      return;
    }
    // A cache hit renders with no confirmation — nothing leaves, so there is
    // nothing to confirm (step 10 supplies the hit itself).
    if (detail.cacheHit) return showReady(detail.outline);
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
    showMessage(`Generating outline with ${detail.label}…`);
    const result = await browser.runtime.sendMessage({
      type: "outline",
      hash: current.hash,
      sections: current.sections,
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

  // Progressive fill under either strategy; step 9 renders the partial sections
  // themselves rather than counting them.
  function progress(partial) {
    if (partial.hash !== current?.hash || !partial.sections) return;
    showMessage(`Generating outline… ${partial.sections.length} sections so far`);
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
  return { start, progress, fail };
}
