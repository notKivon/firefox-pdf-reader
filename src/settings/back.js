// "Back" from the settings page.
//
// Settings opens in a tab of its own, so the browser's own Back has nothing to
// return to. When a reader tab opened it, that tab's id travels in `?from=`, and
// Back switches to it and closes this tab. Opened any other way (about:addons),
// Back uses the tab's history if it has one, and otherwise just closes the tab.

/** @returns {number|null} the reader tab that opened settings, when there is one */
export function returnTabId(search) {
  const raw = new URLSearchParams(search).get("from");
  // Digits only: Number("") is 0, which is a real tab id.
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * @param {object} [env] injectable for tests
 * @returns {Promise<"reader"|"history"|"closed">} where Back went
 */
export async function goBack({ tabs = browser.tabs, search = window.location.search, history = window.history } = {}) {
  const from = returnTabId(search);
  if (from !== null) {
    try {
      await tabs.update(from, { active: true });
      await closeThisTab(tabs);
      return "reader";
    } catch {
      // The reader tab has been closed since; fall through to the other routes.
    }
  }
  if (history.length > 1) {
    history.back();
    return "history";
  }
  await closeThisTab(tabs);
  return "closed";
}

async function closeThisTab(tabs) {
  const current = await tabs.getCurrent();
  if (!current) throw new Error("this page is not in a tab it can close.");
  await tabs.remove(current.id);
}

/**
 * Opens settings for a reader tab, reusing a settings tab that is already open
 * rather than piling up another one each time.
 *
 * @param {object} [env] injectable for tests
 */
export async function openSettingsFrom({ tabs = browser.tabs, runtime = browser.runtime } = {}) {
  const current = await tabs.getCurrent();
  const base = runtime.getURL("settings.html");
  const url = current ? `${base}?from=${current.id}` : base;
  // Filtered by hand: match patterns do not reliably accept moz-extension URLs.
  const existing = (await tabs.query({})).find((tab) => tab.url?.startsWith(base));
  if (existing) await tabs.update(existing.id, { url, active: true });
  else await tabs.create({ url, ...(current ? { openerTabId: current.id } : {}) });
}
