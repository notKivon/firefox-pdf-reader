// Outline | Chat, at the top of the right-hand pane. The chosen tab is a
// per-profile convenience in storage.local; losing it costs nothing.
import { el } from "./el.js";

export const TAB_KEY = "paneTab";

/**
 * @param {object} args
 * @param {HTMLElement} args.bar where the buttons go
 * @param {{id: string, label: string, panels: HTMLElement[]}[]} args.tabs
 */
export async function initPaneTabs({ bar, tabs }) {
  const buttons = tabs.map(({ id, label }) => {
    const button = el("button", "pane-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("data-tab", id);
    button.addEventListener("click", () => {
      select(id);
      browser.storage.local.set({ [TAB_KEY]: id }).catch(() => {});
    });
    return button;
  });
  bar.setAttribute("role", "tablist");
  bar.replaceChildren(...buttons);

  function select(id) {
    for (const [i, tab] of tabs.entries()) {
      const on = tab.id === id;
      buttons[i].setAttribute("aria-selected", String(on));
      buttons[i].classList.toggle("is-active", on);
      for (const panel of tab.panels) panel.hidden = !on;
    }
  }

  let stored;
  try {
    stored = (await browser.storage.local.get(TAB_KEY))?.[TAB_KEY];
  } catch {
    stored = undefined;
  }
  select(tabs.some((tab) => tab.id === stored) ? stored : tabs[0].id);
  return { select };
}
