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
import { cachedOutline, isCacheable, saveOutline } from "../store/outlines.js";
import { status as quotaStatus } from "../store/quota.js";

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
  // Read before anything else is decided: a hit means nothing is sent, so there
  // is nothing to confirm and no counter to move (CLAUDE.md).
  const cached = await cachedOrNull(hash, providerId);

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
    // Every other model, same destination included — what the finished outline
    // offers, where "read this through a different model" is an ordinary want
    // and is not limited to the crossing the card has to ask about.
    otherProviders: othersThan(providerId),
    consented: await consentedOrFalse(key),
    cacheHit: cached !== null,
    outline: cached ?? undefined,
  };
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function othersThan(providerId) {
  return Object.entries(PROVIDERS)
    .filter(([id]) => id !== providerId)
    .map(([id, p]) => ({ id, label: p.label, destination: p.destination }));
}

function alternativesTo(destination) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.destination !== destination)
    .map(([id, p]) => ({ id, label: p.label, destination: p.destination }));
}

// An unreadable cache is a miss, not a failure: the worst it costs is a request
// that need not have been made, and the alternative — failing the open — costs
// the reader the paper.
async function cachedOrNull(hash, providerId) {
  try {
    return await cachedOutline(hash, providerId);
  } catch (err) {
    console.warn("[scholar-reader] outline cache unreadable", err);
    return null;
  }
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
  // Zero network requests on a hit — a correctness requirement rather than an
  // optimisation, and the reason this check sits ahead of the consent gate:
  // there is no send to gate.
  if (detail.cacheHit) return { ...detail.outline, cacheHit: true };

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

  const result = await generateOutline({
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

  return { ...result, ...(await cache(request.hash, result)) };
}

/**
 * Caching is the last thing that happens and the only one allowed to fail
 * quietly: the outline is already on screen, and a paper the reader can read is
 * worth more than one they cannot because the write failed. The cost of the
 * miss is one more request next time, which the note says out loud.
 */
async function cache(hash, result) {
  // A run with malformed sections in it is a partial outline; caching it would
  // make the gaps permanent, since the next open would be a hit.
  if (!isCacheable(result)) {
    return { warning: "Some sections could not be summarised, so this outline was not cached." };
  }
  try {
    await saveOutline(hash, result);
    return {};
  } catch (err) {
    console.warn("[scholar-reader] outline not cached", err);
    return { warning: `This outline could not be cached, so reopening will generate it again: ${err.message}` };
  }
}

const HANDLERS = {
  plan: (message) => plan(message),
  outline: (message, sender) => runOutline(message, sender.tab?.id),
  // Read-only: what today's counters stand at, for the settings page.
  quota: async () => ({
    providers: await Promise.all(
      Object.keys(PROVIDERS)
        .filter((id) => PROVIDERS[id].limits?.rpd)
        .map((id) => quotaStatus(id)),
    ),
  }),
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
