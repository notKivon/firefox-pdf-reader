// Small DOM pieces every settings section uses.
import { el } from "../viewer/el.js";

export { el };

export function button(text, onClick) {
  const node = el("button", "plain", text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/** A line under a control that says what just happened, in words. */
export function statusLine() {
  const node = el("p", "settings-status");
  node.setAttribute("role", "status");
  return {
    node,
    ok(text) {
      node.className = "settings-status";
      node.textContent = text;
    },
    error(text) {
      node.className = "settings-status error";
      node.textContent = text;
    },
  };
}

/**
 * Runs an async action with its controls disabled, and reports a failure on
 * the status line rather than leaving the click unanswered (CLAUDE.md).
 */
export async function act(controls, status, what, fn) {
  for (const control of controls) control.disabled = true;
  try {
    await fn();
  } catch (err) {
    console.error(`[scholar-reader] settings: ${what} failed`, err);
    status.error(`Could not ${what}: ${err?.message ?? err}`);
  } finally {
    for (const control of controls) control.disabled = false;
  }
}

/** Renders a section, replacing it with a readable error if it cannot load. */
export async function renderSection(body, what, render) {
  body.replaceChildren(el("p", "settings-dim", "Loading…"));
  try {
    await render(body);
  } catch (err) {
    console.error(`[scholar-reader] settings: ${what} failed to load`, err);
    body.replaceChildren(el("p", "settings-status error", `The ${what} could not be loaded: ${err?.message ?? err}`));
  }
}
