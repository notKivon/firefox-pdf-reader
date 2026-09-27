// Takes a PDF out of the browser's own response instead of fetching it again.
//
// The interceptor used to redirect to the viewer, which then fetched the URL a
// second time. For a static PDF that costs a round trip; for a publisher that
// signs its PDF links for one use and bot-checks the rest (Elsevier's `pdfft`),
// the second fetch is refused outright. Here the original response is kept: a
// StreamFilter collects its bytes while the tab shows skeleton.js's picture of
// the reader, then the bytes go to the inbox and the tab moves to the viewer.
import { countLabel, createProgress, openingRule, skeletonHead } from "./skeleton.js";

// The same ceiling as a picked local file: past it, holding the whole PDF in
// the event page is the bigger risk, and the viewer's own fetch takes over.
export const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;

// Nothing on the page may run: it is the publisher's origin, and the page is
// ours only for the length of a download.
export const SKELETON_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name)?.value;

/** @returns {number|null} */
export function contentLength(headers) {
  const n = Number(header(headers, "content-length"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether this response can be captured rather than redirected. A 206 is a
 * fragment of a PDF, and an encoded body is a case never verified in Firefox,
 * so both keep the old redirect rather than risk a corrupt capture.
 */
export function canCapture(details, hasFilter) {
  if (!hasFilter || !(details.tabId >= 0) || details.statusCode !== 200) return false;
  const encoding = header(details.responseHeaders, "content-encoding");
  return !encoding || encoding.trim().toLowerCase() === "identity";
}

/**
 * The response headers the tab sees: our HTML under our CSP. Content-Length is
 * left alone — it belongs to the transfer, which is still the PDF's.
 */
export function rewriteHeaders(headers = []) {
  const dropped = new Set(["content-type", "content-disposition", "content-security-policy", "content-security-policy-report-only"]);
  return [
    ...headers.filter((h) => !dropped.has(h.name.toLowerCase())),
    { name: "Content-Type", value: "text/html; charset=utf-8" },
    { name: "Content-Security-Policy", value: SKELETON_CSP },
  ];
}

function concat(chunks, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Starts capturing one response. Call from a blocking onHeadersReceived and
 * return `{responseHeaders}` of the result.
 *
 * @param {object} details webRequest.onHeadersReceived details
 * @param {object} deps
 * @param {(requestId: string) => object} deps.filterResponseData
 * @param {(entry: {url: string, bytes: Uint8Array, timing: object}) => Promise<string>} deps.stash
 * @param {(tabId: number, url: string) => Promise<unknown>} deps.navigate
 * @param {(url: string, token?: string) => string} deps.viewerUrl
 * @param {string} deps.name what the skeleton calls the paper
 * @param {{theme: string, outlineWidth: number}} deps.prefs
 * @param {() => number} [deps.now]
 * @returns {{responseHeaders: object[]}}
 */
export function beginCapture(details, deps) {
  const { filterResponseData, stash, navigate, viewerUrl, name, prefs, now = () => Date.now() } = deps;
  const { url, tabId } = details;
  const total = contentLength(details.responseHeaders);
  const filter = filterResponseData(details.requestId);
  const encoder = new TextEncoder();
  const progress = createProgress(total);
  const timing = { headers: now() };
  const chunks = [];
  let received = 0;
  let overflow = false;

  const write = (text) => filter.write(encoder.encode(text));

  filter.onstart = () => {
    write(skeletonHead({ name, theme: prefs.theme, outlineWidth: prefs.outlineWidth, total }));
  };

  filter.ondata = ({ data }) => {
    received += data.byteLength;
    if (!overflow && received > MAX_CAPTURE_BYTES) {
      overflow = true;
      chunks.length = 0;
    }
    if (!overflow) chunks.push(new Uint8Array(data));
    const rule = progress.update(received);
    if (rule) write(rule);
  };

  filter.onstop = async () => {
    timing.complete = now();
    // Any failure here still ends in the reader: without a token it fetches the
    // URL itself, and if that fails too it says so in its own error pane.
    let target = viewerUrl(url);
    if (overflow) {
      console.warn(`[scholar-reader] ${countLabel(received, null)} is over the capture ceiling; the viewer will fetch it`);
    } else if (received === 0) {
      console.warn("[scholar-reader] the PDF response had no body; the viewer will fetch it");
    } else {
      try {
        const token = await stash({ url, bytes: concat(chunks, received), timing });
        timing.stashed = now();
        target = viewerUrl(url, token);
      } catch (err) {
        console.error("[scholar-reader] could not hand the captured PDF to the viewer", err);
      }
    }
    chunks.length = 0;
    try {
      write(openingRule());
      filter.close();
    } catch (err) {
      console.warn("[scholar-reader] the capture page closed early", err);
    }
    try {
      await navigate(tabId, target);
    } catch (err) {
      console.error("[scholar-reader] could not move the tab to the reader", err);
    }
  };

  // The tab navigated away or closed mid-download, or the network failed. The
  // browser shows its own page for the last two; there is nothing to hand on.
  filter.onerror = () => {
    chunks.length = 0;
    console.warn("[scholar-reader] PDF capture ended early:", filter.error);
  };

  return { responseHeaders: rewriteHeaders(details.responseHeaders) };
}
