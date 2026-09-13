// Changing model on an outline that has already been generated.
//
// The confirm card and the error state each offer the OTHER DESTINATIONS,
// because those are the two moments CLAUDE.md requires a deliberate choice to be
// available at. This is a third moment and a wider list: once an outline is on
// screen, "read this paper through a different model" is an ordinary thing to
// want, and it should not require closing the tab or revoking a grant.
//
// Nothing here decides anything. It re-plans, and the plan does what it always
// does: a model whose cache already holds this paper renders from it with no
// request, one with a grant sends, and one with neither asks first. Crossing to
// the local model is the same act as any other switch — its own cache key, so
// its own confirmation.
import { el } from "./el.js";

const DESTINATION_NOTE = { local: "on this machine", google: "Google" };

/**
 * @param {object} plan the router's `plan` response for the model in use
 * @param {(providerId: string) => void} onPick
 * @returns {HTMLElement|null} null when there is nothing to switch to
 */
export function providerSwitch(plan, onPick) {
  const others = plan?.otherProviders ?? [];
  if (others.length === 0) return null;

  const box = el("div", "outline-switch");
  box.append(el("span", "outline-switch-label", "Outline this paper with:"));

  for (const other of others) {
    const where = DESTINATION_NOTE[other.destination] ?? other.destination;
    const button = el("button", "outline-switch-go", `${other.label} — ${where}`);
    button.type = "button";
    button.addEventListener("click", () => onPick(other.id));
    box.append(button);
  }
  return box;
}
