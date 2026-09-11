// Document records: identity by content hash, metadata, and reading position.
import { DOCS, get, update } from "./db.js";

// arXiv ids in both the modern (2401.01234) and legacy (cs.CL/0112017) shapes.
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/;

// A document's identity is the sha256 of its raw bytes, never its URL: the same
// paper fetched from arXiv and from a publisher must land on one record.
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fileName(url) {
  try {
    const { pathname, host } = new URL(url);
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : host;
  } catch {
    return url;
  }
}

function splitAuthors(raw) {
  if (!raw) return [];
  // Only unambiguous separators: a comma may well be inside "Doe, John".
  return raw
    .split(/\s*;\s*|\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

function firstMatch(re, ...haystacks) {
  for (const text of haystacks) {
    const match = typeof text === "string" ? text.match(re) : null;
    if (match) return match[1];
  }
  return undefined;
}

// PDF metadata is frequently absent or junk ("Microsoft Word - paper.doc"), so
// every field here is best-effort and the URL is a co-equal source.
export async function readDocumentMeta(pdfDoc, url) {
  let info = {};
  try {
    ({ info = {} } = await pdfDoc.getMetadata());
  } catch (err) {
    console.warn("[scholar-reader] no PDF metadata", err);
  }
  const title = info.Title?.trim();
  const meta = {
    title: title && !/^untitled$/i.test(title) ? title : fileName(url),
    authors: splitAuthors(info.Author),
    pageCount: pdfDoc.numPages,
  };
  const arxivId = firstMatch(ARXIV_RE, url);
  const doi = firstMatch(DOI_RE, url, info.Subject, info.Keywords, title);
  if (arxivId) meta.arxivId = arxivId;
  if (doi) meta.doi = doi;
  return meta;
}

function mergeUrls(existing, url) {
  const urls = Array.isArray(existing) ? existing.filter((u) => u !== url) : [];
  // Most recent first, and bounded: a paper can be reached from many mirrors.
  return [url, ...urls].slice(0, 10);
}

export function getDoc(hash) {
  return get(DOCS, hash);
}

// Upserts the record for this opening and returns it, including the reading
// position saved by the previous one.
export async function recordOpen({ hash, url, pdfDoc }) {
  const meta = await readDocumentMeta(pdfDoc, url);
  const now = Date.now();
  return update(DOCS, hash, (existing) => ({
    lastPage: 1,
    scrollTop: 0,
    scrollHeight: 0,
    firstOpened: now,
    ...existing,
    ...meta,
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
