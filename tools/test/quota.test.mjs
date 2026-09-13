import assert from "node:assert/strict";
import { installIndexedDb } from "./idb.mjs";

const db = installIndexedDb();
const { hasRoomFor, quotaDay, record, resetsAt, resetsAtText, status, used } = await import(
  "../../src/store/quota.js"
);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

// 2026-09-14T05:00Z is the 14th in UTC and the 14th in Hong Kong, but still the
// 13th in California — which is the whole reason this module exists.
const LATE_PACIFIC = Date.parse("2026-09-14T05:00:00Z");

await test("the quota day is the Pacific calendar date, not UTC and not the reader's", async () => {
  assert.equal(quotaDay(LATE_PACIFIC), "2026-09-13");
  assert.equal(new Date(LATE_PACIFIC).toISOString().slice(0, 10), "2026-09-14", "UTC has moved on");
});

await test("counts accumulate within a day and start again on the next one", async () => {
  await record("gemini-prod", 3, LATE_PACIFIC);
  await record("gemini-prod", 2, LATE_PACIFIC);
  assert.equal(await used("gemini-prod", LATE_PACIFIC), 5);

  // A stubbed date change: same provider, next Pacific day, counter back to zero.
  const nextDay = LATE_PACIFIC + 24 * 3600 * 1000;
  assert.equal(quotaDay(nextDay), "2026-09-14");
  assert.equal(await used("gemini-prod", nextDay), 0, "a new quota day is a new counter");
  assert.equal(await used("gemini-prod", LATE_PACIFIC), 5, "yesterday's row is kept, not rewritten");
  assert.equal(db.records("quota").length, 1, "tomorrow's row is not created by reading it");
});

await test("a provider's counter is its own", async () => {
  await record("gemini-dev", 7, LATE_PACIFIC);
  assert.equal(await used("gemini-dev", LATE_PACIFIC), 7);
  assert.equal(await used("gemini-prod", LATE_PACIFIC), 5);
});

await test("room is judged against the whole run, not one request", async () => {
  const at = Date.parse("2026-05-05T12:00:00Z");
  await record("gemini-prod", 9_995, at); // rpd 10,000
  assert.equal(await hasRoomFor("gemini-prod", 5, at), true, "exactly the last five fit");
  assert.equal(await hasRoomFor("gemini-prod", 6, at), false, "a run that cannot finish never starts");
  assert.equal(await hasRoomFor("gemini-prod", 1, at + 24 * 3600 * 1000), true, "the next day is clear");
});

await test("a provider with no daily limit is never refused", async () => {
  const at = Date.parse("2026-05-05T12:00:00Z");
  await record("ollama", 50_000, at);
  assert.equal(await hasRoomFor("ollama", 500, at), true, "nothing is being metered locally");
});

await test("the reset instant is the next Pacific midnight, across both DST edges", () => {
  // Mid-September: PDT, UTC-7.
  assert.equal(new Date(resetsAt(LATE_PACIFIC)).toISOString(), "2026-09-14T07:00:00.000Z");
  // The evening DST ends: midnight is still PDT, the change comes at 2am.
  const fallBack = Date.parse("2026-11-01T05:00:00Z"); // Oct 31, 22:00 PDT
  assert.equal(new Date(resetsAt(fallBack)).toISOString(), "2026-11-01T07:00:00.000Z");
  // The evening DST begins: midnight is still PST, UTC-8.
  const springForward = Date.parse("2026-03-08T05:00:00Z"); // Mar 7, 21:00 PST
  assert.equal(new Date(resetsAt(springForward)).toISOString(), "2026-03-08T08:00:00.000Z");
});

await test("the reset is told to the reader in Hong Kong time", () => {
  const text = resetsAtText(LATE_PACIFIC);
  assert.match(text, /Hong Kong time$/);
  assert.match(text, /Mon 14 Sept?, 15:00/, `got: ${text}`); // 07:00Z is 15:00 in HKT
});

await test("status reports what the settings page needs", async () => {
  const at = Date.parse("2026-06-06T12:00:00Z");
  await record("gemini-prod", 12, at);
  const state = await status("gemini-prod", at);
  assert.equal(state.used, 12);
  assert.equal(state.rpd, 10_000);
  assert.equal(state.remaining, 9_988);
  assert.equal(state.resetsAt, resetsAt(at));
  const local = await status("ollama", at);
  assert.equal(local.rpd, null);
  assert.equal(local.remaining, null, "no limit means no number to count down");
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
