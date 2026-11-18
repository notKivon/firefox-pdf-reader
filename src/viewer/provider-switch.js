// Choosing another model, as one dropdown (2026-11-18, at the user's request;
// it was a row of buttons). Used in three places: under a finished outline
// ("outline this paper with…"), on the confirm card and in the error state
// ("or send it somewhere else"). Those last two offer the OTHER DESTINATIONS,
// because they are the moments CLAUDE.md requires a deliberate choice to be
// available at.
//
// Nothing here decides anything. Picking re-plans, and the plan does what it
// always does: a model whose cache already holds this paper renders from it
// with no request, one with a grant sends, and one with neither asks first.
import { el } from "./el.js";

const GROUPS = [
  ["anthropic", "Anthropic — via Claude Code"],
  ["google", "Google"],
  ["local", "On this machine"],
];

/**
 * @param {{id: string, label: string, destination: string}[]} options
 * @param {object} args
 * @param {string} args.label what choosing does, shown before the dropdown
 * @param {(providerId: string) => void} args.onPick
 * @param {string} [args.className] the wrapper's class
 * @returns {HTMLElement|null} null when there is nothing to choose
 */
export function modelPicker(options, { label, onPick, className = "outline-switch" }) {
  if (!options?.length) return null;
  const box = el("div", className);
  const select = el("select", "model-picker");
  select.setAttribute("aria-label", label);

  const prompt = el("option", null, "Choose a model…");
  prompt.value = "";
  prompt.disabled = true;
  prompt.selected = true;
  select.append(prompt);

  const known = new Set(GROUPS.map(([destination]) => destination));
  for (const [destination, name] of [...GROUPS, ...[...new Set(options.map((o) => o.destination))].filter((d) => !known.has(d)).map((d) => [d, d])]) {
    const members = options.filter((option) => option.destination === destination);
    if (!members.length) continue;
    const group = el("optgroup");
    group.label = name;
    for (const { id, label: text } of members) {
      const option = el("option", null, text.replace(/\s*\(via Claude Code\)$/, ""));
      option.value = id;
      group.append(option);
    }
    select.append(group);
  }

  select.addEventListener("change", () => {
    if (select.value) onPick(select.value);
  });
  box.append(el("span", "outline-switch-label", label), select);
  return box;
}

/**
 * Under a finished outline: every other model, this one's destination included.
 * @param {object} plan the router's `plan` response for the model in use
 * @param {(providerId: string) => void} onPick
 */
export function providerSwitch(plan, onPick) {
  return modelPicker(plan?.otherProviders, { label: "Outline this paper with:", onPick });
}
