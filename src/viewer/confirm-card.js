// The outline pane's first state for any document with no consent record.
//
// CLAUDE.md: this is a *state of the pane*, never `window.confirm` or any other
// modal, and nothing is sent until the button is pressed. It says what would be
// sent and where, and nothing more (2026-11-21, at the user's request: the
// title repeated the toolbar, and token counts, model ids and "via Claude
// Code" were noise for a reader on a subscription):
//
//   Outline with [Claude Opus 5.5 ▾]        — the question; the model is the choice
//   Sends the 18-page PDF to Anthropic.     — the fact: what leaves, and for where
//   [ Generate outline ]                    — the one action
//
// A cost appears only where a per-token price is known; a missing key is said
// before the click. There is no auto-dismiss and no timeout: the paper reads in
// the left pane regardless, which is what makes blocking here acceptable.
import { el } from "./el.js";
import { modelSelect, shortName } from "./provider-switch.js";

const WHERE = { google: "Google", anthropic: "Anthropic" };

const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

// One decimal of a cent, marked approximate: the token count behind it is an
// estimate, not a tokeniser's.
function costText(dollars) {
  const cents = dollars * 100;
  return cents < 0.1 ? "<0.1¢" : `≈${cents.toFixed(1)}¢`;
}

// What leaves the machine and where it goes, in one sentence.
function factText(plan) {
  if (plan.destination === "local") return "Stays on this machine.";
  const where = WHERE[plan.destination] ?? plan.destination;
  if (plan.pdf) return `Sends the ${plan.pdf.pages}-page PDF to ${where}.`;
  if (plan.modelSections) return `Sends the paper's text to ${where}.`;
  return `Sends ${plural(plan.sectionCount, "section")} of text to ${where}.`;
}

// For a provider sent the extracted sections, which ones: the honest short
// answer to "what exactly goes", folded away.
function sectionList(titles) {
  const box = el("details", "confirm-what");
  box.append(el("summary", null, "Which sections"));
  const list = el("ol", "confirm-titles");
  for (const title of titles) list.append(el("li", null, title));
  box.append(list);
  return box;
}

/**
 * @param {object} plan the router's `plan` response
 * @param {{onConfirm: () => void, onPickProvider: (id: string) => void}} handlers
 * @returns {HTMLElement}
 */
export function confirmCard(plan, { onConfirm, onPickProvider }) {
  const card = el("section", `confirm-card is-${plan.destination}`);

  const ask = el("p", "confirm-ask");
  const current = { id: plan.providerId, label: plan.label, destination: plan.destination };
  const options = [current, ...(plan.otherProviders ?? [])];
  if (options.length > 1) {
    // Another model is a different thing being sent somewhere, so choosing one
    // re-plans — it renders from that model's cache, or asks again.
    // A native select is as wide as its longest option, which pushed the name
    // onto a line of its own. So the chosen name is shown as text, sized to
    // itself, with the real select laid invisibly over it: same clicks, same
    // keyboard, same screen-reader control.
    const choice = el("span", "confirm-model");
    choice.append(
      el("span", "confirm-model-name", shortName(plan.label)),
      modelSelect(options, { label: "Model", onPick: onPickProvider, selectedId: plan.providerId, className: "confirm-model-select" }),
    );
    ask.append(el("span", null, "Outline with "), choice);
  } else {
    ask.append(el("span", null, `Outline with ${shortName(plan.label)}`));
  }
  card.append(ask);

  const fact = el("p", "confirm-fact", factText(plan));
  if (plan.estCost !== null && plan.estCost !== undefined) fact.append(el("span", "confirm-cost", ` ${costText(plan.estCost)}`));
  card.append(fact);

  // Said before the click rather than discovered after it. The button stays
  // live regardless: consent is permission, not success, and a grant recorded
  // now means entering the key later does not ask again.
  if (!plan.hasKey && plan.destination !== "local") {
    card.append(el("p", "confirm-warn", plan.bridge ? "Add your bridge token in Settings first." : "Add your API key in Settings first."));
  }

  const go = el("button", "confirm-go", "Generate outline");
  go.type = "button";
  go.addEventListener("click", () => onConfirm());
  card.append(go);

  if (!plan.modelSections && plan.sectionTitles?.length) card.append(sectionList(plan.sectionTitles));
  return card;
}
