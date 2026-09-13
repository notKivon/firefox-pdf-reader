// The toolbar controls that lead out of the current reading: settings, the
// browser's own viewer, and another PDF from this computer.
//
import { openSettingsFrom } from "../settings/back.js";

// Each of them fails in words, beside the outline, rather than silently — the
// paper is still on screen, so none of these is worth an error over the page.

/**
 * @param {object} args
 * @param {HTMLElement} args.settings
 * @param {HTMLElement} args.nativeViewer
 * @param {HTMLElement} args.openLocal
 * @param {(text: string) => void} args.onNote
 */
export function initActions({ settings, nativeViewer, openLocal, onNote }) {
  // Not `runtime.openOptionsPage()`: settings needs to know which tab to return
  // to, and that call cannot carry it.
  settings.addEventListener("click", () => {
    openSettingsFrom().catch((err) => onNote(`Settings could not be opened: ${err.message}`));
  });

  let source = null;

  // Before a document is open, the picker belongs to this page (viewer.js wires
  // it). Once one is, this tab is committed to that paper — its outline, its
  // reading position — so another file opens in a fresh viewer instead of being
  // swapped in underneath them.
  const openAnother = () => {
    browser.tabs
      .create({ url: browser.runtime.getURL("viewer.html") })
      .catch((err) => onNote(`A new viewer tab could not be opened: ${err.message}`));
  };

  nativeViewer.addEventListener("click", async () => {
    if (!source || source.local) return;
    try {
      await leaveForNativeViewer(source.url);
    } catch (err) {
      onNote(err.message);
    }
  });

  return {
    /** Called once the document is open. */
    setSource(next) {
      source = next;
      nativeViewer.hidden = next.local;
      openLocal.addEventListener("click", openAnother);
    },
  };
}

/**
 * The escape hatch. The interceptor would redirect a plain navigation straight
 * back here, so the background is asked for one pass for this tab first; only
 * once it has agreed does the tab navigate. The history entry is kept, so Back
 * returns to Scholar Reader.
 *
 * @param {string} url
 * @param {{navigate?: (url: string) => void}} [options]
 */
export async function leaveForNativeViewer(url, { navigate = (to) => window.location.assign(to) } = {}) {
  let reply;
  try {
    reply = await browser.runtime.sendMessage({ type: "bypass" });
  } catch (err) {
    throw new Error(`The browser's own viewer could not be opened: ${err.message}`);
  }
  if (!reply?.ok) {
    throw new Error(reply?.message ?? "The browser's own viewer could not be opened: the background page did not answer.");
  }
  navigate(url);
}
