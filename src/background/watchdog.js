// A run that stops making progress is abandoned rather than waited on forever.
//
// CLAUDE.md: a failed model call must never leave the outline pane in a silent
// spinner. A provider that accepts the request and then never answers has not
// failed in any way a fetch reports — no status, no network error — so without
// this the pane would say "Generating…" until the tab closed.
//
// Idle, not total: a local model working through twenty sections legitimately
// takes minutes, but it lands a section every few seconds while it does. What is
// timed is the gap since the last sign of life.
export const STALL_MS = 180_000;

/**
 * @param {object} [options]
 * @param {number} [options.ms]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 */
export function createWatchdog({ ms = STALL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  let fired = false;
  let timer = null;

  const arm = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      fired = true;
      controller.abort();
    }, ms);
  };
  arm();

  return {
    signal: controller.signal,
    /** Something arrived; the run is alive. */
    poke() {
      if (!fired) arm();
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get fired() {
      return fired;
    },
    ms,
  };
}
