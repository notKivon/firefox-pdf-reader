// Sends PDF main-frame responses to the Scholar Reader viewer.
//
// The trigger is the Content-Type header, never the URL extension: arXiv and
// most publishers serve PDFs from extensionless URLs.
//
// Two ways to get there. The normal one captures the response the browser is
// already receiving (capture.js) so the PDF is fetched once. The redirect, which
// makes the viewer fetch the URL again, is kept only for what capture cannot
// safely take: no tab to move, a partial (206) or content-encoded body, or a
// browser without StreamFilter.
import { normalizeHosts, OPT_OUT_KEY } from "../store/settings.js";
import { stash, sweep } from "../store/inbox.js";
import { nameOf } from "../viewer/source.js";
import { beginCapture, canCapture } from "./capture.js";
import { createPrefs } from "./prefs.js";

const VIEWER_PAGE = "viewer.html";

// Normalised on read as well as on save, so a value written before the settings
// page existed (or by hand) still compares by bare lower-case hostname.
const hostSet = (stored) => new Set(normalizeHosts(stored ?? []).hosts);

// Hosts the user has excluded. Replaced wholesale on storage change.
let optOutHosts = new Set();

function declaresPdf(responseHeaders) {
  if (!responseHeaders) return false;
  for (const header of responseHeaders) {
    if (header.name.toLowerCase() !== "content-type") continue;
    if (/application\/pdf/i.test(header.value ?? "")) return true;
  }
  return false;
}

/**
 * Pure decision function, so it is testable without a browser.
 * @param {object} details webRequest.onHeadersReceived details
 * @param {Set<string>} optOut hostnames to leave alone
 */
export function shouldIntercept(details, optOut = optOutHosts) {
  if (details.type !== "main_frame") return false;
  // 3xx has no body yet and 204 has none at all; only redirect real payloads.
  if (details.statusCode !== 200 && details.statusCode !== 206) return false;

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return false;
  }
  // Firefox only permits redirecting http(s); file:// PDFs use the viewer's
  // own "open local file" control instead.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (optOut.has(url.hostname)) return false;

  return declaresPdf(details.responseHeaders);
}

/**
 * @param {string} originalUrl where the PDF came from
 * @param {string} [token] the inbox entry holding its captured bytes
 */
export function viewerUrlFor(originalUrl, token) {
  const base = browser.runtime.getURL(VIEWER_PAGE);
  const capture = token ? `&capture=${encodeURIComponent(token)}` : "";
  return `${base}?file=${encodeURIComponent(originalUrl)}${capture}`;
}

// Replacing the history entry keeps Back pointing at the page the PDF was
// clicked from, not at the capture page — whose URL, for a single-use link,
// would only be refused if revisited. `loadReplace` is Firefox's own option; if
// a build rejects it, an extra history entry beats a tab stuck on the skeleton.
async function navigateTab(tabId, url) {
  try {
    await browser.tabs.update(tabId, { url, loadReplace: true });
  } catch (err) {
    console.warn("[scholar-reader] tabs.update refused loadReplace; navigating without it", err);
    await browser.tabs.update(tabId, { url });
  }
}

// Set at registration; null only when registered without an escape hatch.
let bypass = null;
let prefs = { theme: "dark", outlineWidth: 360 };

function onHeadersReceived(details) {
  if (!shouldIntercept(details, optOutHosts)) return {};
  // The reader asked for the browser's own viewer for this tab's next PDF.
  if (bypass?.consume(details.tabId)) return {};
  const filterResponseData = browser.webRequest.filterResponseData?.bind(browser.webRequest);
  if (!canCapture(details, Boolean(filterResponseData))) {
    return { redirectUrl: viewerUrlFor(details.url) };
  }
  return beginCapture(details, {
    filterResponseData,
    stash,
    navigate: navigateTab,
    viewerUrl: viewerUrlFor,
    name: nameOf(details.url),
    prefs,
  });
}

function onStorageChanged(changes, area) {
  if (area !== "local" || !(OPT_OUT_KEY in changes)) return;
  optOutHosts = hostSet(changes[OPT_OUT_KEY].newValue);
}

/**
 * Registers the listener synchronously — an event page must have its blocking
 * listeners attached during the first turn or it can miss requests on wake-up.
 * The opt-out list loads right after; the set is empty for that one tick.
 *
 * @param {{bypass?: {consume(tabId: number): boolean}}} [deps]
 */
export function registerInterceptor(deps = {}) {
  bypass = deps.bypass ?? null;
  prefs = createPrefs();
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking", "responseHeaders"],
  );
  browser.storage.onChanged.addListener(onStorageChanged);

  browser.storage.local
    .get(OPT_OUT_KEY)
    .then((stored) => {
      optOutHosts = hostSet(stored[OPT_OUT_KEY]);
    })
    .catch((err) => {
      // Failing open means PDFs still render; an opt-out host is merely ignored.
      console.error("[scholar-reader] could not read the origin opt-out list", err);
    });

  // Captures the viewer never opened (a tab closed mid-handoff) expire here too.
  sweep().catch((err) => console.warn("[scholar-reader] inbox sweep failed", err));
}
