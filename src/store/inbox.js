// Captured PDF bytes on their way from the background to a viewer tab.
//
// The background captures a PDF out of the browser's own response (see
// background/capture.js) and the viewer tab it then opens needs those bytes.
// The bytes wait here, in the background's own IndexedDB, so they survive the
// event page being suspended before the viewer asks. The viewer asks through
// the router's `capture` message and never opens this store itself: an
// extension page in a container tab has its own partition of IndexedDB (seen
// live in Zen, whose workspaces use containers) and would find it empty.
//
// An entry is read, not consumed: reloading the reader must not fall back to
// fetching the URL again, because for the publishers this exists for (Elsevier's
// single-use `pdfft` links) a second fetch is exactly what gets refused. Entries
// expire instead, swept on every stash and when the background starts.
import { INBOX, del, get, getAll, put } from "./db.js";

export const INBOX_TTL_MS = 60 * 60 * 1000;

/**
 * @param {{url: string, bytes: Uint8Array, timing?: object}} entry
 * @param {() => number} [now]
 * @returns {Promise<string>} the token the viewer asks for
 */
export async function stash({ url, bytes, timing = {} }, now = () => Date.now()) {
  const token = crypto.randomUUID();
  await put(INBOX, { token, url, bytes, timing, createdAt: now() });
  // Not awaited into the caller's path: a failed sweep costs disk, not a paper.
  sweep(now).catch((err) => console.warn("[scholar-reader] inbox sweep failed", err));
  return token;
}

/**
 * @param {string} token
 * @param {() => number} [now]
 * @returns {Promise<{url: string, bytes: Uint8Array, timing: object}|null>}
 *   null when the token is unknown or has expired
 */
export async function claim(token, now = () => Date.now()) {
  if (!token) return null;
  const entry = await get(INBOX, token);
  if (!entry || now() - entry.createdAt > INBOX_TTL_MS) return null;
  return entry;
}

/** Deletes every entry older than the TTL. @returns {Promise<number>} how many */
export async function sweep(now = () => Date.now()) {
  // getAll reads the bytes too, which is fine while the inbox holds the last
  // hour's papers and nothing more — which is what this sweep keeps true.
  const stale = (await getAll(INBOX)).filter((entry) => now() - entry.createdAt > INBOX_TTL_MS);
  for (const entry of stale) await del(INBOX, entry.token);
  return stale.length;
}
