// The pane's error state.
//
// CLAUDE.md: a failed model call must never leave the pane in a silent spinner,
// so every failure lands here, in words, with a way forward.
//
// The way forward includes the other destinations. The confirm card carries them
// too, but the card is only ever shown once per cache key — after the grant it
// never returns, so without this an error would strand the reader on the one
// provider that just failed. It is also what CLAUDE.md requires of an exhausted
// chain: state the problem and *offer* another destination, as a choice, never
// as an automatic fallback.
import { el } from "./el.js";

/**
 * @param {string} text what went wrong, in words
 * @param {object} options
 * @param {() => void} [options.retry]
 * @param {object} [options.plan] the router's plan, for its `alternatives`
 * @param {(id: string) => void} [options.onPickProvider]
 * @returns {HTMLElement}
 */
export function errorBox(text, { retry, plan, onPickProvider } = {}) {
  const box = el("div", "outline-error");
  box.append(el("p", "pane-error", text));

  if (retry) {
    const button = el("button", "confirm-go", "Try again");
    button.type = "button";
    button.addEventListener("click", retry);
    box.append(button);
  }

  if (plan?.alternatives?.length && onPickProvider) {
    const alt = el("div", "confirm-alt");
    alt.append(el("span", "confirm-alt-label", "Or send it somewhere else:"));
    for (const other of plan.alternatives) {
      const button = el("button", "confirm-alt-go", other.label);
      button.type = "button";
      button.addEventListener("click", () => onPickProvider(other.id));
      alt.append(button);
    }
    box.append(alt);
  }
  return box;
}
