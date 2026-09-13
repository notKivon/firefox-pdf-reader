// `plan`: what an outline request WOULD send, and where, without sending it.
//
// The confirm card renders it and the router's gate is checked against it. It
// makes no network request of any kind — that is the point of it being a
// separate message.
import { estimateCost, estimateTokens, totalChars } from "../model/estimate.js";
import { getProvider, PROVIDERS } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { cacheKey } from "../store/cache-key.js";
import { isConsented } from "../store/consent.js";
import { cachedOutline } from "../store/outlines.js";
import { DEFAULT_ORDER, getProviderOrder } from "../store/settings.js";

/**
 * The reader's provider order from settings. Unreadable settings fall back to
 * the shipped order rather than failing the open: the shipped order is Gemini
 * first, which is the stated default anyway, and every send still asks first.
 */
export async function providerOrder() {
  try {
    return await getProviderOrder();
  } catch (err) {
    console.warn("[scholar-reader] provider order unreadable, using the default", err);
    return DEFAULT_ORDER;
  }
}

/**
 * @param {{hash: string, sections: object[], meta?: object, providerId?: string}} request
 *   `providerId` absent means "the reader's default", which is the first entry
 *   of their order in settings.
 */
export async function plan({ hash, sections, meta = {}, providerId }) {
  const order = await providerOrder();
  const id = providerId ?? order[0];
  const provider = getProvider(id);
  const sendable = sections.filter((section) => section.text.trim().length > 0);
  const chars = totalChars(sendable);
  const estTokens = estimateTokens(chars);
  const requests = provider.strategy === "whole-document" ? 1 : sendable.length + 1;
  const key = cacheKey(hash, id);
  // Read before anything else is decided: a hit means nothing is sent, so there
  // is nothing to confirm and no counter to move (CLAUDE.md).
  const cached = await cachedOrNull(hash, id);

  return {
    cacheKey: key,
    hash,
    title: meta.title ?? "",
    pageCount: meta.pageCount ?? 0,
    providerId: id,
    model: provider.model,
    destination: provider.destination,
    label: provider.label,
    host: hostOf(provider.baseUrl),
    strategy: provider.strategy,
    sectionCount: sendable.length,
    sectionTitles: sendable.map((section) => section.title),
    chars,
    estTokens,
    estCost: estimateCost(id, estTokens, requests),
    requests,
    hasKey: (await getApiKey(provider.keyRef).catch(() => null)) !== null,
    // The reader may deliberately choose another destination; nothing ever
    // reaches one automatically (CLAUDE.md), so the card offers them by name.
    alternatives: listed(order, (other) => other.destination !== provider.destination),
    // Every other model, same destination included — what the finished outline
    // offers, where "read this through a different model" is an ordinary want
    // and is not limited to the crossing the card has to ask about.
    otherProviders: listed(order, (_, otherId) => otherId !== id),
    order,
    consented: await consentedOrFalse(key),
    cacheHit: cached !== null,
    outline: cached ?? undefined,
  };
}

// In the reader's order, so the lists the pane offers match the settings page.
function listed(order, keep) {
  return order
    .filter((otherId) => keep(PROVIDERS[otherId], otherId))
    .map((otherId) => ({ id: otherId, label: PROVIDERS[otherId].label, destination: PROVIDERS[otherId].destination }));
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
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
// card then renders and the real gate in the router, which does not swallow, is
// what reports the store failure if the reader goes ahead.
async function consentedOrFalse(key) {
  try {
    return await isConsented(key);
  } catch (err) {
    console.warn("[scholar-reader] consent record unreadable", err);
    return false;
  }
}
