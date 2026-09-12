// The message router: the ONLY place a provider is ever called.
//
// Two reasons it lives here rather than in the viewer (SPEC.md): background
// fetches to hosts in `host_permissions` are not subject to CORS, and no API key
// ever reaches the viewer context. A third, from CLAUDE.md: the send
// confirmation gate is enforced here, so a viewer that forgets to ask cannot
// cause a send.
import { outline as generateOutline } from "../model/adapter.js";
import { estimateCost, estimateTokens, totalChars } from "../model/estimate.js";
import { ProviderError } from "../model/errors.js";
import { DEFAULT_PROVIDER_ID, getProvider } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { cacheKey } from "../store/cache-key.js";

const PROGRESS_MESSAGE = "outline-progress";

/**
 * What the confirm card renders and what the gate is checked against. Makes no
 * network request of any kind — that is the point of it being a separate
 * message: the viewer can find out what WOULD be sent, and where, without
 * anything being sent.
 *
 * @param {{hash: string, sections: object[], meta?: object, providerId?: string}} request
 */
export async function plan({ hash, sections, meta = {}, providerId = DEFAULT_PROVIDER_ID }) {
  const provider = getProvider(providerId);
  const sendable = sections.filter((section) => section.text.trim().length > 0);
  const chars = totalChars(sendable);
  const estTokens = estimateTokens(chars);
  const requests = provider.strategy === "whole-document" ? 1 : sendable.length + 1;

  return {
    cacheKey: cacheKey(hash, providerId),
    providerId,
    model: provider.model,
    destination: provider.destination,
    label: provider.label,
    strategy: provider.strategy,
    sectionCount: sendable.length,
    sectionTitles: sendable.map((section) => section.title),
    chars,
    estTokens,
    estCost: estimateCost(providerId, estTokens, requests),
    requests,
    hasKey: (await getApiKey(provider.keyRef)) !== null,
    // Both arrive with the steps that own them: consent in step 8, the cache in
    // step 10. Until then the honest answer to each is "no", which is also the
    // safe one — see the gate in `runOutline`.
    consented: false,
    cacheHit: false,
  };
}

// CLAUDE.md: no document's text is sent to any model until the reader confirms
// it for that cache key, and the check is the router's, not the viewer's.
//
// Step 8 replaces this with a read of `store/consent.js`. Until that store
// exists there are no grants, so every send is refused — which is the correct
// failure direction, and means the viewer's confirm card is what unblocks the
// path rather than the router quietly allowing it in the meantime.
async function isConsented(_key) {
  return false;
}

/**
 * @param {{hash, sections, meta, providerId}} request
 * @param {number|undefined} tabId the tab to stream progress to
 */
export async function runOutline(request, tabId) {
  const detail = await plan(request);
  if (!(await isConsented(detail.cacheKey))) {
    // Not an error the pane reports as a failure: it is the card's cue.
    return { error: "consent-required", plan: detail };
  }

  const onProgress = tabId === undefined ? undefined : (partial) => {
    browser.tabs
      .sendMessage(tabId, { type: PROGRESS_MESSAGE, hash: request.hash, ...partial })
      .catch(() => {
        // The viewer navigated away mid-run. The result still completes and is
        // still cached; there is simply no one to show it to.
      });
  };

  return generateOutline({
    sections: request.sections,
    providerId: detail.providerId,
    meta: request.meta,
    resolveKey: getApiKey,
    onProgress,
    onProviderChange: (id) => {
      if (tabId !== undefined) {
        browser.tabs
          .sendMessage(tabId, { type: PROGRESS_MESSAGE, hash: request.hash, providerId: id })
          .catch(() => {});
      }
    },
  });
}

const HANDLERS = {
  plan: (message) => plan(message),
  outline: (message, sender) => runOutline(message, sender.tab?.id),
};

/**
 * Firefox resolves a promise returned from an onMessage listener, so every
 * handler can be async. Errors are converted rather than thrown: an Error does
 * not survive the structured clone, and CLAUDE.md requires every async boundary
 * to surface in the UI rather than hang.
 */
export function registerRouter() {
  browser.runtime.onMessage.addListener((message, sender) => {
    const handler = HANDLERS[message?.type];
    if (!handler) return undefined;
    return handler(message, sender).catch((err) => {
      console.error(`[scholar-reader] ${message.type} failed`, err);
      if (err instanceof ProviderError) return err.toJSON();
      return { error: "internal", message: String(err?.message ?? err) };
    });
  });
}
