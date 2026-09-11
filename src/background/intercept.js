// Redirects PDF main-frame responses to the Scholar Reader viewer.
//
// The trigger is the Content-Type header, never the URL extension: arXiv and
// most publishers serve PDFs from extensionless URLs.
const VIEWER_PAGE = "viewer.html";
const OPT_OUT_KEY = "optOutHosts";

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

export function viewerUrlFor(originalUrl) {
  const base = browser.runtime.getURL(VIEWER_PAGE);
  return `${base}?file=${encodeURIComponent(originalUrl)}`;
}

function onHeadersReceived(details) {
  if (!shouldIntercept(details, optOutHosts)) return {};
  return { redirectUrl: viewerUrlFor(details.url) };
}

function onStorageChanged(changes, area) {
  if (area !== "local" || !(OPT_OUT_KEY in changes)) return;
  optOutHosts = new Set(changes[OPT_OUT_KEY].newValue ?? []);
}

/**
 * Registers the listener synchronously — an event page must have its blocking
 * listeners attached during the first turn or it can miss requests on wake-up.
 * The opt-out list loads right after; the set is empty for that one tick.
 */
export function registerInterceptor() {
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking", "responseHeaders"],
  );
  browser.storage.onChanged.addListener(onStorageChanged);

  browser.storage.local
    .get(OPT_OUT_KEY)
    .then((stored) => {
      optOutHosts = new Set(stored[OPT_OUT_KEY] ?? []);
    })
    .catch((err) => {
      // Failing open means PDFs still render; an opt-out host is merely ignored.
      console.error("[scholar-reader] could not read the origin opt-out list", err);
    });
}
