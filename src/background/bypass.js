// The escape hatch: "open this in the browser's own viewer".
//
// The interceptor redirects every PDF main-frame response, so simply navigating
// back to the original URL would land in Scholar Reader again. Instead the
// viewer asks for one pass for its own tab, and the next PDF that tab loads is
// left alone.
//
// Scoped to the tab rather than to the URL, because the URL the reader clicked
// is often not the URL that answers with the PDF — arXiv and publishers redirect
// — and a pass keyed on the first would be spent on a 302 and never reach the
// second. Short-lived and single-use, so a pass that is never used cannot
// quietly turn interception off for that tab later.
export const BYPASS_TTL_MS = 30_000;

/** @param {() => number} [now] */
export function createBypass(now = () => Date.now()) {
  const passes = new Map(); // tabId -> expiry, epoch ms

  return {
    /** @param {number} tabId */
    grant(tabId) {
      if (typeof tabId !== "number" || tabId < 0) return false;
      passes.set(tabId, now() + BYPASS_TTL_MS);
      return true;
    },

    /**
     * Called only for a response the interceptor would otherwise redirect, so a
     * pass is spent on the PDF itself and never on a redirect before it.
     * @param {number} tabId
     * @returns {boolean} true when this response should be let through
     */
    consume(tabId) {
      const expiry = passes.get(tabId);
      if (expiry === undefined) return false;
      passes.delete(tabId);
      return expiry >= now();
    },
  };
}
