// The outline cache.
//
// CLAUDE.md: a cache hit makes zero network requests and renders with no
// confirmation — nothing leaves the machine, so there is nothing to confirm.
// That is also why the entry is keyed by the full cache key rather than by the
// document: a different provider, model, chunking strategy or prompt version
// produces a different artifact, and an outline written by an older prompt is
// never served as the current one.
import { OUTLINES, del, get, getAll, getAllByIndex, put } from "./db.js";
import { cacheKey } from "./cache-key.js";

/**
 * @param {string} hash sha256 of the raw PDF bytes
 * @param {string} providerId
 * @returns {Promise<object|null>} the cached record, or null on a miss
 */
export async function cachedOutline(hash, providerId) {
  const record = await get(OUTLINES, cacheKey(hash, providerId));
  return record ?? null;
}

/**
 * Written only from a result that has already passed the adapter's alignment
 * checksum (SPEC.md): an unverified outline must never become a cache entry,
 * because it would then be served with no confirmation and no network request
 * and its bullets would scroll to the wrong place forever.
 *
 * Keyed by the provider that actually *served* the result, which fallback may
 * have changed — the entry names the artifact it holds, not the one that was
 * asked for.
 *
 * @param {string} hash
 * @param {{sections: object[], tldr: string, providerId: string, model: string, strategy: string, usage: object}} result
 */
export async function saveOutline(hash, result) {
  return put(OUTLINES, {
    key: cacheKey(hash, result.providerId),
    hash,
    sections: result.sections,
    tldr: result.tldr ?? "",
    providerId: result.providerId,
    model: result.model,
    strategy: result.strategy,
    usage: result.usage ?? null,
    createdAt: Date.now(),
  });
}

/**
 * A run where some sections came back malformed is a partial outline. Caching
 * it would make the gaps permanent: the next open is a cache hit, so there
 * would be no request and no way back to a complete one.
 */
export const isCacheable = (result) =>
  Array.isArray(result?.sections) && !result.sections.some((section) => section.error);

/** Every cached outline for one document, across providers and prompt versions. */
export function outlinesFor(hash) {
  return getAllByIndex(OUTLINES, "hash", hash);
}

export function deleteOutline(key) {
  return del(OUTLINES, key);
}

/** Every cached outline on record, for the settings page's list. */
export function allOutlines() {
  return getAll(OUTLINES);
}

/**
 * Forgets every cached outline for one document, so its next open plans afresh.
 * Consent is a separate record and is untouched: a paper still approved sends
 * again without asking, which is what that approval said.
 */
export async function forgetOutlines(hash) {
  const records = await outlinesFor(hash);
  for (const record of records) await deleteOutline(record.key);
  return records.length;
}
