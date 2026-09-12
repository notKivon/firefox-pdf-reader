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
import { DEFAULT_PROVIDER_ID, getProvider, PROVIDERS } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { cacheKey } from "../store/cache-key.js";
import { isConsented } from "../store/consent.js";

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
  const key = cacheKey(hash, providerId);

  return {
    cacheKey: key,
    hash,
    title: meta.title ?? "",
    pageCount: meta.pageCount ?? 0,
    providerId,
    model: provider.model,
    destination: provider.destination,
    label: provider.label,
    host: hostOf(provider.baseUrl),
    strategy: provider.strategy,
    sectionCount: sendable.length,
    sectionTitles: sendable.map((section) => section.title),
    chars,
    estTokens,
    estCost: estimateCost(providerId, estTokens, requests),
    requests,
    hasKey: (await getApiKey(provider.keyRef)) !== null,
    // The reader may deliberately choose another destination; nothing ever
    // reaches one automatically (CLAUDE.md), so the card offers them by name.
    alternatives: alternativesTo(provider.destination),
    consented: await consentedOrFalse(key),
    // Step 10's, along with the outline cache itself. "No" is the safe answer
    // until then: it costs a confirmation, never a silent send.
    cacheHit: false,
  };
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function alternativesTo(destination) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.destination !== destination)
    .map(([id, p]) => ({ id, label: p.label, destination: p.destination }));
}

// An unreadable store must read as "not consented" — never as consented. The
// card then renders and the real gate below, which does not swallow, is what
// reports the store failure if the reader goes ahead.
async function consentedOrFalse(key) {
  try {
    return await isConsented(key);
  } catch (err) {
    console.warn("[scholar-reader] consent record unreadable", err);
    return false;
  }
}

/**
 * @param {{hash, sections, meta, providerId}} request
 * @param {number|undefined} tabId the tab to stream progress to
 */
export async function runOutline(request, tabId) {
  const detail = await plan(request);
  // Deliberately re-read rather than trusting `detail.consented`: the gate is
  // the router's own read of the store, so nothing the viewer sends — a stubbed
  // check, a forged flag on the message — can stand in for a grant.
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
