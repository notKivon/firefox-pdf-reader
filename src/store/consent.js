// Send consent: the record that says the reader agreed to *this* text going to
// *this* destination.
//
// CLAUDE.md: no document's text reaches any model — the local one included —
// until the reader confirms it for that document, and the grant is scoped to the
// cache key `sha256:providerId:model:strategy:promptVersion`. So one approval
// covers that paper from any URL and survives reopening, while a different
// provider, model, chunking strategy or prompt version is a different thing
// being sent somewhere and asks again.
//
// This module only reads and writes. The gate itself is `background/router.js`,
// which is the only place a provider call can originate.
import { CONSENTS, del, get, getAllByIndex, put } from "./db.js";

/**
 * @param {string} key the cache key the send would use
 * @returns {Promise<boolean>}
 */
export async function isConsented(key) {
  if (!key) return false;
  return (await get(CONSENTS, key)) !== undefined;
}

/**
 * Written from the confirm card's accept path, before anything is sent, so a
 * crash mid-request cannot lose the grant and re-ask.
 *
 * @param {{cacheKey: string, hash: string, providerId: string, model: string, destination: string}} plan
 */
export async function grantConsent({ cacheKey, hash, providerId, model, destination }) {
  return put(CONSENTS, {
    key: cacheKey,
    hash,
    providerId,
    model,
    destination,
    grantedAt: Date.now(),
  });
}

/** Every grant for one document, across providers and prompt versions. */
export function consentsFor(hash) {
  return getAllByIndex(CONSENTS, "hash", hash);
}

export function revokeConsent(key) {
  return del(CONSENTS, key);
}

/** Revoking a document revokes all of it: the settings page offers one control. */
export async function revokeDocument(hash) {
  const records = await consentsFor(hash);
  for (const record of records) await revokeConsent(record.key);
  return records.length;
}
