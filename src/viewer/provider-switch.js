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
  box.append(el("span", "outline-switch-label", label), modelSelect(options, { label, onPick, className: "model-picker" }));
  return box;
}

/**
 * The dropdown itself, grouped by destination. With `selectedId`, that model
 * is shown as chosen; without, a "Choose a model…" prompt is.
 *
 * @param {{id: string, label: string, destination: string}[]} options
 * @param {{label: string, onPick: (id: string) => void, selectedId?: string, className?: string}} args
 */
export function modelSelect(options, { label, onPick, selectedId, className = "model-picker" }) {
  const select = el("select", className);
  select.setAttribute("aria-label", label);
  if (!selectedId) {
    const prompt = el("option", null, "Choose a model…");
    prompt.value = "";
    prompt.disabled = true;
    prompt.selected = true;
    select.append(prompt);
  }
  const known = new Set(GROUPS.map(([destination]) => destination));
  const extra = [...new Set(options.map((o) => o.destination))].filter((d) => !known.has(d)).map((d) => [d, d]);
  for (const [destination, name] of [...GROUPS, ...extra]) {
    const members = options.filter((option) => option.destination === destination);
    if (!members.length) continue;
    const group = el("optgroup");
    group.label = name;
    for (const { id, label: text } of members) {
      const option = el("option", null, shortName(text));
      option.value = id;
      option.selected = id === selectedId;
      group.append(option);
    }
    select.append(group);
  }
  select.addEventListener("change", () => {
    if (select.value && select.value !== selectedId) onPick(select.value);
  });
  return select;
}

// The reader knows the Claude models run through Claude Code; the label need
// not say so every time.
export const shortName = (label) => String(label ?? "").replace(/\s*\(via Claude Code\)$/, "");

/**
 * The one model control (2026-11-21, at the user's request: one dropdown with
 * every model in it, everywhere). "[lead] [model ▾]": the current model's name
 * as text, with the real select laid invisibly over it — a native select is as
 * wide as its longest option, which pushed the name onto a line of its own.
 * Same clicks, same keyboard, same screen-reader control.
 *
 * @param {object} plan the router's plan: providerId, label, destination, otherProviders
 * @param {{lead: string, onPick: (id: string) => void, className?: string}} args
 * @returns {HTMLElement}
 */
export function modelChoice(plan, { lead, onPick, className = "model-line" }) {
  const line = el("p", className);
  const current = { id: plan.providerId, label: plan.label, destination: plan.destination };
  const options = [current, ...(plan.otherProviders ?? [])];
  if (options.length < 2 || !plan.providerId) {
    line.append(el("span", null, `${lead} ${shortName(plan.label)}`));
    return line;
  }
  const choice = el("span", "model-choice");
  choice.append(
    el("span", "model-choice-name", shortName(plan.label)),
    modelSelect(options, { label: "Model", onPick, selectedId: plan.providerId, className: "model-choice-select" }),
  );
  line.append(el("span", null, `${lead} `), choice);
  return line;
}
