// A running outline says what it is doing, how long it has taken, when it has
// gone quiet, and can be stopped (2026-11-21). Words and clicks, so tested over
// the fake DOM; time is injected, so nothing here waits.
import assert from "node:assert/strict";

import { FakeNode } from "./dom.mjs";

const { outlineProgress, QUIET_WARN_MS } = await import("../../src/viewer/outline-progress.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

function harness(extra = {}) {
  let t = 1_000_000;
  let tick = null;
  let cleared = false;
  let stops = 0;
  const p = outlineProgress({
    label: "Claude Opus 5.5",
    pdf: true,
    onStop: () => stops++,
    now: () => t,
    setTick: (fn) => ((tick = fn), 1),
    clearTick: () => (cleared = true),
    ...extra,
  });
  return {
    p,
    advance(ms) { t += ms; tick(); },
    text: (cls) => p.node.find(cls).textContent,
    get stops() { return stops; },
    get cleared() { return cleared; },
  };
}

test("it names the model, the stage and the time taken", () => {
  const h = harness();
  assert.equal(h.text("progress-model"), "Claude Opus 5.5");
  assert.equal(h.text("progress-stage"), "Sending");
  h.p.update({ stage: "reading" });
  assert.equal(h.text("progress-stage"), "Reading the PDF");
  h.p.update({ stage: "thinking" });
  h.advance(72_000);
  assert.equal(h.text("progress-stage"), "Thinking");
  assert.equal(h.text("progress-time"), "1:12");
});

test("sections landing count up under the writing stage", () => {
  const h = harness();
  h.p.update({ sections: [{}, {}, {}] });
  assert.equal(h.text("progress-stage"), "Writing the outline, 3 sections done");
  h.p.update({ sections: [{}] });
  assert.equal(h.text("progress-stage"), "Writing the outline, 1 section done");
});

test("silence is said only after a while, and a sign of life clears it", () => {
  const h = harness();
  h.advance(QUIET_WARN_MS - 1_000);
  assert.equal(h.p.node.find("progress-quiet").hidden, true, "a short quiet is normal");
  h.advance(7_000);
  assert.equal(h.p.node.find("progress-quiet").hidden, false);
  assert.match(h.text("progress-quiet"), /^Nothing new for 51 s\. A run silent for 3 minutes is stopped\.$/);
  h.p.update({ alive: true });
  assert.equal(h.p.node.find("progress-quiet").hidden, true);
});

test("Stop asks once and shows that it is stopping", () => {
  const h = harness();
  const stop = h.p.node.find("progress-stop");
  stop.click();
  assert.equal(h.stops, 1);
  assert.equal(stop.disabled, true);
  assert.equal(stop.textContent, "Stopping…");
});

test("a paper sent as text is read as the paper, and dispose stops the clock", () => {
  const h = harness({ pdf: false });
  h.p.update({ stage: "reading" });
  assert.equal(h.text("progress-stage"), "Reading the paper");
  h.p.dispose();
  assert.equal(h.cleared, true);
});

console.log(results.join("\n"));
console.log(`\nprogress: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
