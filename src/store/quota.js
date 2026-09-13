// Per-provider request counters, one row per provider per quota day.
//
// CLAUDE.md: Google's daily quota resets at midnight **US Pacific**, not local
// time and not UTC, so the day a request is counted against is the calendar
// date `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`
// produces — which tracks Pacific DST on its own, so there is no offset
// constant here to go stale twice a year. That string is the only place in the
// project where a date is not rendered in Asia/Hong_Kong; the reset *time* the
// reader is shown is converted back, because they are the one waiting for it.
import { QUOTA, get, update } from "./db.js";
import { getProvider } from "../model/providers.js";

const QUOTA_ZONE = "America/Los_Angeles";
const READING_ZONE = "Asia/Hong_Kong";

const quotaDate = new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_ZONE });

/** The Pacific calendar date counters are keyed by, e.g. "2026-09-13". */
export function quotaDay(at = Date.now()) {
  return quotaDate.format(at);
}

const rowKey = (providerId, day) => `${providerId}:${day}`;

/** Requests already sent to `providerId` today. Yesterday's row is simply not read. */
export async function used(providerId, at = Date.now()) {
  const row = await get(QUOTA, rowKey(providerId, quotaDay(at)));
  return row?.count ?? 0;
}

/**
 * Counts requests that were actually dispatched, so the counter cannot drift
 * below the provider's own tally. Read-modify-write in one transaction: the
 * viewer and the background page hold separate connections.
 */
export async function record(providerId, count = 1, at = Date.now()) {
  const day = quotaDay(at);
  const key = rowKey(providerId, day);
  const row = await update(QUOTA, key, (existing) => ({
    key,
    providerId,
    day,
    count: (existing?.count ?? 0) + count,
  }));
  return row.count;
}

/**
 * Is there room for a run of `requests`? A descriptor with no `limits.rpd` —
 * the local model — is unlimited by definition: nothing is being metered.
 */
export async function hasRoomFor(providerId, requests = 1, at = Date.now()) {
  const rpd = getProvider(providerId).limits?.rpd;
  if (!rpd) return true;
  return (await used(providerId, at)) + requests <= rpd;
}

/** `{used, rpd, remaining, resetsAt}` for one provider — the settings readout. */
export async function status(providerId, at = Date.now()) {
  const rpd = getProvider(providerId).limits?.rpd ?? null;
  const count = await used(providerId, at);
  return {
    providerId,
    used: count,
    rpd,
    remaining: rpd === null ? null : Math.max(0, rpd - count),
    resetsAt: resetsAt(at),
    resetsAtText: resetsAtText(at),
  };
}

const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// How far the quota zone is ahead of UTC at that instant, to the minute. Read
// off the formatter rather than assumed, so DST needs no table.
function offsetMs(at) {
  const parts = Object.fromEntries(
    zoneParts.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24, // en-US hour12:false renders midnight as 24
    +parts.minute,
    +parts.second,
  );
  return Math.round((asUtc - at) / 60_000) * 60_000;
}

/** Epoch ms of the next Pacific midnight — the instant today's counters stop counting. */
export function resetsAt(at = Date.now()) {
  const [year, month, day] = quotaDay(at).split("-").map(Number);
  // Tomorrow's Pacific midnight read as though it were UTC, then walked back by
  // the real offset. Twice: on a DST night the offset at the guess and the
  // offset actually in force at the answer are an hour apart.
  const wallClock = Date.UTC(year, month - 1, day + 1);
  const first = wallClock - offsetMs(wallClock);
  return wallClock - offsetMs(first);
}

const resetText = new Intl.DateTimeFormat("en-GB", {
  timeZone: READING_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The reset instant in the reader's own timezone, which is the only one they can act on. */
export function resetsAtText(at = Date.now()) {
  return `${resetText.format(resetsAt(at))} Hong Kong time`;
}
