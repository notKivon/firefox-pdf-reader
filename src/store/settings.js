// The reader's settings that are not keys: which provider goes first, and which
// hosts keep the browser's own PDF viewer. `browser.storage.local`, per profile.
//
// Keys live in `apikeys.js`; theme and pane width stay with the viewer modules
// that own them. What is here is read by the background page as well as by the
// settings page, so both halves agree on one normalisation.
import { DEFAULT_PROVIDER_ID, FALLBACK_ORDER, PROVIDERS } from "../model/providers.js";

export const PROVIDER_ORDER_KEY = "providerOrder";
// Read by background/intercept.js under this exact name since step 2.
export const OPT_OUT_KEY = "optOutHosts";

// The shipped order: the default first, its same-destination fallbacks next,
// and every other provider after them. Where a provider sits after the first
// place only matters within its own destination (see `fallbacksFor`), so the
// local model's position here can never make it an automatic target.
export const DEFAULT_ORDER = [
  DEFAULT_PROVIDER_ID,
  ...FALLBACK_ORDER.filter((id) => id !== DEFAULT_PROVIDER_ID),
  ...Object.keys(PROVIDERS).filter((id) => id !== DEFAULT_PROVIDER_ID && !FALLBACK_ORDER.includes(id)),
];

/**
 * Whatever is stored, a complete order of known ids: unknown ids (a provider
 * removed since the value was saved) are dropped, duplicates collapse, and a
 * provider added since is appended in its shipped place. A bad stored value
 * therefore degrades to the default rather than to a broken router.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
export function normalizeOrder(stored) {
  const seen = new Set();
  const order = [];
  for (const id of Array.isArray(stored) ? stored : []) {
    if (typeof id === "string" && id in PROVIDERS && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of DEFAULT_ORDER) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * One host per entry. Accepts what a reader is likely to paste — a full URL,
 * a host with a port or a path, mixed case — and keeps the hostname, which is
 * what `shouldIntercept` compares against.
 *
 * @param {string|string[]} input a textarea's value, or a stored list
 * @returns {{hosts: string[], rejected: string[]}}
 */
export function normalizeHosts(input) {
  const entries = Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/);
  const hosts = [];
  const rejected = [];
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;
    const host = hostnameOf(entry);
    if (!host) rejected.push(entry);
    else if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts, rejected };
}

function hostnameOf(entry) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`);
    // A hostname has at least one dot or is localhost; "foo" alone is almost
    // certainly a typo, and silently storing it would opt out nothing.
    if (!/\./.test(url.hostname) && url.hostname !== "localhost") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function getProviderOrder() {
  const stored = await browser.storage.local.get(PROVIDER_ORDER_KEY);
  return normalizeOrder(stored?.[PROVIDER_ORDER_KEY]);
}

export async function setProviderOrder(order) {
  const normalized = normalizeOrder(order);
  await browser.storage.local.set({ [PROVIDER_ORDER_KEY]: normalized });
  return normalized;
}

export async function getOptOutHosts() {
  const stored = await browser.storage.local.get(OPT_OUT_KEY);
  return normalizeHosts(stored?.[OPT_OUT_KEY] ?? []).hosts;
}

export async function setOptOutHosts(hosts) {
  const normalized = normalizeHosts(hosts).hosts;
  await browser.storage.local.set({ [OPT_OUT_KEY]: normalized });
  return normalized;
}
