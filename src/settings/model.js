// The settings page's decisions, kept apart from its DOM so they can be tested
// in Node: how grants are grouped and dated, how a stored key is shown, and
// what a move in the provider list produces.
import { PROVIDERS } from "../model/providers.js";

const READING_ZONE = "Asia/Hong_Kong";

const dateText = new Intl.DateTimeFormat("en-GB", {
  timeZone: READING_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Epoch ms → a date in Hong Kong time, per CLAUDE.md. */
export function formatWhen(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `${dateText.format(ms)} HKT` : "unknown date";
}

/**
 * Grants grouped per document, the most recently granted document first. A
 * grant whose document record is gone (history cleared, or a store failure) is
 * still listed — under its hash — because it still authorises a send.
 *
 * @param {object[]} consents `{key, hash, providerId, model, destination, grantedAt}`
 * @param {Map<string, object>} docs hash → docs record
 */
export function groupGrants(consents, docs) {
  const groups = new Map();
  for (const grant of consents) {
    let group = groups.get(grant.hash);
    if (!group) {
      const doc = docs.get(grant.hash);
      group = { hash: grant.hash, title: doc?.title || `Document ${grant.hash.slice(0, 12)}…`, grants: [], latest: 0 };
      groups.set(grant.hash, group);
    }
    group.grants.push({
      key: grant.key,
      label: PROVIDERS[grant.providerId]?.label ?? grant.providerId,
      model: grant.model,
      destination: grant.destination,
      when: formatWhen(grant.grantedAt),
    });
    group.latest = Math.max(group.latest, grant.grantedAt ?? 0);
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

/** Enough of a stored key to recognise it, never enough to use it. */
export function maskKey(key) {
  if (typeof key !== "string" || !key) return null;
  return key.length <= 8 ? "…" : `…${key.slice(-4)}`;
}

/**
 * @param {string[]} order
 * @param {number} index
 * @param {-1|1} delta
 * @returns {string[]} a new order; the same contents when the move is off the end
 */
export function moveItem(order, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Distinct key references among the providers, with who uses each. */
export function keyRefs() {
  const refs = new Map();
  for (const provider of Object.values(PROVIDERS)) {
    if (!provider.keyRef) continue;
    if (!refs.has(provider.keyRef)) refs.set(provider.keyRef, []);
    refs.get(provider.keyRef).push(provider.label);
  }
  return [...refs.entries()].map(([ref, users]) => ({ ref, users }));
}

export function destinationText(destination) {
  return destination === "local" ? "stays on this machine" : `sent to ${destination[0].toUpperCase()}${destination.slice(1)}`;
}
