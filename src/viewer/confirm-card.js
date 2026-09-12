// The outline pane's first state for any document with no consent record.
//
// CLAUDE.md: this is a *state of the pane*, never `window.confirm` or any other
// modal. It states what would be sent and where — title, pages, sections,
// approximate tokens, provider label, model id, and whether the text leaves the
// machine — and nothing is sent until the button is pressed. There is no
// auto-dismiss and no timeout: the paper reads in the left pane regardless,
// which is what makes blocking here acceptable.
import { el } from "./el.js";

const DESTINATION_NAMES = { google: "Google", local: "this machine" };

const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

// One decimal of a cent, and always marked an estimate: the token count behind
// it is characters ÷ 4, not a tokeniser.
function costLine(dollars) {
  const cents = dollars * 100;
  return cents < 0.1 ? "Estimated cost under 0.1¢" : `Estimated cost ~${cents.toFixed(1)}¢`;
}

// The question the card exists to answer is "where does this go", so the answer
// is in words rather than in a hostname the reader has to decode.
function destinationLine(plan) {
  const where = DESTINATION_NAMES[plan.destination] ?? plan.destination;
  const what = `${plan.label} (${plan.model})`;
  return plan.destination === "local"
    ? `Stays on ${where} — ${what} at ${plan.host}`
    : `Sent to ${where} — ${what}`;
}

// "What exactly gets sent" deserves an honest answer, and the section titles are
// the short one. The References cutoff has already run, so this list is what
// goes — nothing more.
function whatGetsSent(titles) {
  const box = el("details", "confirm-what");
  box.append(el("summary", null, `What gets sent — ${plural(titles.length, "section")}`));
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
  const card = el("section", "confirm-card");
  card.append(
    el("h2", "confirm-heading", "Generate outline"),
    el("p", "confirm-doc", plan.pageCount ? `${plan.title} — ${plural(plan.pageCount, "page")}` : plan.title),
    el(
      "p",
      "confirm-meta",
      [
        plural(plan.sectionCount, "section"),
        `~${plan.estTokens.toLocaleString("en")} tokens`,
        plural(plan.requests, "request"),
      ].join(" · "),
    ),
    el("p", `confirm-dest is-${plan.destination}`, destinationLine(plan)),
  );
  if (plan.estCost !== null && plan.estCost !== undefined) {
    card.append(el("p", "confirm-cost", costLine(plan.estCost)));
  }
  card.append(whatGetsSent(plan.sectionTitles));

  // Said before the click rather than discovered after it. The button stays
  // live regardless: consent is permission, not success, and a grant recorded
  // now means entering the key later does not ask again.
  if (!plan.hasKey && plan.destination !== "local") {
    card.append(el("p", "confirm-warn", `No API key is stored for ${plan.label} yet — add one in settings.`));
  }
  const go = el("button", "confirm-go", "Generate outline");
  go.type = "button";
  go.addEventListener("click", () => onConfirm());
  card.append(go);

  if (plan.alternatives?.length) {
    const alt = el("div", "confirm-alt");
    alt.append(el("span", "confirm-alt-label", "Or send it somewhere else:"));
    for (const other of plan.alternatives) {
      const button = el("button", "confirm-alt-go", other.label);
      button.type = "button";
      // Another destination is a different thing being sent somewhere, so this
      // re-plans and asks again rather than proceeding.
      button.addEventListener("click", () => onPickProvider(other.id));
      alt.append(button);
    }
    card.append(alt);
  }
  return card;
}
