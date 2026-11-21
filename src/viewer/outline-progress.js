// What a running outline is doing, while it does it (2026-11-21, at the user's
// request: a slow run and a stuck one looked the same, and there was no way to
// stop either).
//
//   Claude Opus 5.5
//   ● Thinking                                   1:12
//   Nothing new for 52 s. A run silent for 3 minutes is stopped.
//   [ Stop ]
//
// The stage comes from the bridge ("reading", "thinking", "writing") or, from a
// provider with no stages, "writing" at its first token. The dot pulses each
// time the run shows life, so a working run visibly breathes and a stuck one
// visibly does not. The router sends a life sign at most every 5 s.
import { el } from "./el.js";

// Before this much silence the warning would only be noise: Opus reading a long
// PDF can say nothing for half a minute and be fine.
export const QUIET_WARN_MS = 45_000;

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function stageText(stage, { pdf, done }) {
  if (stage === "reading") return pdf ? "Reading the PDF" : "Reading the paper";
  if (stage === "thinking") return "Thinking";
  if (stage === "writing") return done ? `Writing the outline, ${done} section${done === 1 ? "" : "s"} done` : "Writing the outline";
  return "Sending";
}

/**
 * @param {{label: string, pdf?: boolean, onStop: () => void, now?: () => number,
 *   setTick?: typeof setInterval, clearTick?: typeof clearInterval}} args
 * @returns {{node: HTMLElement, update: (msg: {stage?, alive?, sections?}) => void,
 *   stopping: () => void, dispose: () => void}}
 */
export function outlineProgress({ label, pdf = false, onStop, now = Date.now, setTick = setInterval, clearTick = clearInterval }) {
  const started = now();
  let heard = started;
  let stage = null;
  let done = 0;

  const node = el("section", "outline-progress");
  node.setAttribute("aria-live", "polite");
  const model = el("p", "progress-model", label);
  const row = el("p", "progress-row");
  const dot = el("span", "progress-dot");
  dot.setAttribute("aria-hidden", "true");
  const what = el("span", "progress-stage", stageText(stage, { pdf, done }));
  const time = el("span", "progress-time", clock(0));
  row.append(dot, what, time);
  const quiet = el("p", "progress-quiet");
  quiet.hidden = true;
  const stop = el("button", "progress-stop", "Stop");
  stop.type = "button";
  stop.addEventListener("click", () => {
    stopping();
    onStop();
  });
  node.append(model, row, quiet, stop);

  function render() {
    const t = now();
    time.textContent = clock(t - started);
    const silent = t - heard;
    quiet.hidden = silent < QUIET_WARN_MS;
    if (!quiet.hidden) {
      quiet.textContent = `Nothing new for ${Math.round(silent / 1000)} s. A run silent for 3 minutes is stopped.`;
    }
  }
  const tick = setTick(render, 1000);

  // Restarts the pulse: the class comes off and goes back on.
  function pulse() {
    dot.classList?.remove("is-beat");
    void dot.offsetWidth;
    dot.classList?.add("is-beat");
  }

  function update({ stage: next, alive, sections } = {}) {
    heard = now();
    if (next) stage = next;
    if (sections) {
      done = sections.length;
      stage = "writing";
    }
    if (next || sections || alive) pulse();
    what.textContent = stageText(stage, { pdf, done });
    render();
  }

  function stopping() {
    stop.disabled = true;
    stop.textContent = "Stopping…";
  }

  return { node, update, stopping, dispose: () => clearTick(tick) };
}
