// The router's handlers for everything the viewer and settings pages keep:
// document records, reading positions, and send consents.
//
// They live behind messages rather than being imported by those pages because a
// tab in a container (Zen workspaces use them) gets its own partition of
// IndexedDB. A grant written from a reader tab in a container landed where the
// router's gate could not see it, and the card came straight back after every
// click. With every read and write here, there is one partition: the
// background's.
import { getProvider } from "../model/providers.js";
import { cacheKey } from "../store/cache-key.js";
import { allConsents, grantConsent, revokeAll, revokeDocument } from "../store/consent.js";
import { getDoc, readingPosition, recordOpen, saveReadingPosition } from "../store/docs.js";

const HASH_RE = /^[0-9a-f]{64}$/;

function requireHash(hash) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new Error("not a document hash.");
  return hash;
}

/**
 * A grant is recorded against the key the router derives, not one the page
 * supplies: the page names the document and the provider, and the model and
 * destination come from the descriptor. The key the card showed must match the
 * derived one, so a card rendered under an older prompt version cannot grant
 * the current one.
 */
async function grant({ hash, providerId, cacheKey: shown }) {
  requireHash(hash);
  const provider = getProvider(providerId);
  const key = cacheKey(hash, providerId);
  if (shown !== key) {
    throw new Error("the approval was for a different send than the one this version would make. Reload the page and approve again.");
  }
  await grantConsent({ cacheKey: key, hash, providerId, model: provider.model, destination: provider.destination });
  return { ok: true };
}

async function openDoc({ hash, url, meta }) {
  const record = await recordOpen({ hash: requireHash(hash), url: typeof url === "string" ? url : undefined, meta });
  return { title: record.title, pageCount: record.pageCount, position: readingPosition(record) };
}

async function savePosition({ hash, position }) {
  const { page, scrollTop, scrollHeight } = position ?? {};
  if (![page, scrollTop, scrollHeight].every(Number.isFinite)) throw new Error("not a reading position.");
  await saveReadingPosition(requireHash(hash), { page, scrollTop, scrollHeight });
  return { ok: true };
}

// The settings list: every grant, with each document's record for its title. A
// missing or unreadable record costs the title, not the list.
async function consents() {
  const grants = await allConsents();
  const docs = {};
  for (const hash of new Set(grants.map((g) => g.hash))) {
    docs[hash] = (await getDoc(hash).catch(() => null)) ?? null;
  }
  return { consents: grants, docs };
}

// One document, or all of them — never "all" by omission.
async function revoke({ hash, all }) {
  if (all === true) return { count: await revokeAll() };
  return { count: await revokeDocument(requireHash(hash)) };
}

export function recordHandlers() {
  return {
    grant,
    "open-doc": openDoc,
    "save-position": savePosition,
    consents,
    revoke,
  };
}
