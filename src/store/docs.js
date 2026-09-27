// Document records: identity by content hash, metadata, and reading position.
//
// Background only, through the router's `open-doc` and `save-position`: a reader
// tab in a container has its own partition of IndexedDB, so records written from
// it would be invisible to every other tab. Hashing and reading the PDF's own
// metadata happen in the viewer (`viewer/doc-meta.js`), which has the bytes.
import { DOCS, get, update } from "./db.js";

// The fields a record takes from the viewer's `readDocumentMeta`, and no others:
// the message is the viewer's word, so it cannot overwrite identity or history.
const META_FIELDS = ["title", "authors", "pageCount", "arxivId", "doi"];

function pickMeta(meta = {}) {
  const out = {};
  for (const field of META_FIELDS) if (meta[field] !== undefined) out[field] = meta[field];
  return out;
}

function mergeUrls(existing, url) {
  const urls = Array.isArray(existing) ? existing.filter((u) => u !== url) : [];
  // Most recent first, and bounded: a paper can be reached from many mirrors.
  // A picked local file has no URL, and is not one.
  return (url ? [url, ...urls] : urls).slice(0, 10);
}

export function getDoc(hash) {
  return get(DOCS, hash);
}

// Upserts the record for this opening and returns it, including the reading
// position saved by the previous one.
export async function recordOpen({ hash, url, meta }) {
  const now = Date.now();
  return update(DOCS, hash, (existing) => ({
    lastPage: 1,
    scrollTop: 0,
    scrollHeight: 0,
    firstOpened: now,
    ...existing,
    ...pickMeta(meta),
    hash,
    urls: mergeUrls(existing?.urls, url),
    lastOpened: now,
  }));
}

export function readingPosition(record) {
  if (!record) return null;
  return {
    page: record.lastPage ?? 1,
    scrollTop: record.scrollTop ?? 0,
    scrollHeight: record.scrollHeight ?? 0,
  };
}

// Position is only ever written onto an existing record: a save racing ahead of
// recordOpen must not create a record with no identity metadata on it.
export async function saveReadingPosition(hash, { page, scrollTop, scrollHeight }) {
  await update(DOCS, hash, (existing) =>
    existing ? { ...existing, lastPage: page, scrollTop, scrollHeight, lastOpened: Date.now() } : undefined,
  );
}
