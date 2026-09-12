// Scroll-spy: which section the reader is actually in, so the outline can say
// so without being asked.

// How far down the page a heading has to be before it counts as "here". A line
// at the very top would make the current section flicker on every small scroll.
const ACTIVE_LINE = 0.3;

/**
 * The last section whose heading has passed the line. Pure, and the part worth
 * testing on its own: `offsets` are in scroll-container space and ascending,
 * with `null` where the page is not laid out yet.
 *
 * @param {(number|null)[]} offsets
 * @param {number} line
 * @returns {number} the section index, or -1 above the first heading
 */
export function activeIndex(offsets, line) {
  let active = -1;
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    // An unmeasurable section is skipped, not treated as passed: a page pdf.js
    // has not laid out yet says nothing about where the reader is.
    if (offset === null || offset === undefined) continue;
    if (offset > line) break;
    active = i;
  }
  return active;
}

/**
 * @param {{container: HTMLElement, view: object, onChange: (index: number) => void}} args
 */
export function trackCurrentSection({ container, view, onChange }) {
  let targets = [];
  let active = -1;
  let frame = 0;

  function measure() {
    frame = 0;
    const line = container.scrollTop + container.clientHeight * ACTIVE_LINE;
    const index = targets.length ? activeIndex(targets.map((t) => view.offsetOf(t)), line) : -1;
    if (index === active) return;
    active = index;
    onChange(index);
  }

  // One measurement per frame at most: scroll fires far faster than the pane can
  // usefully change, and each measurement asks pdf.js for every offset.
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  container.addEventListener("scroll", schedule, { passive: true });
  // Zoom and a pane resize move every offset without scrolling anything.
  view.eventBus.on("scalechanging", schedule);
  view.eventBus.on("pagesloaded", schedule);

  return {
    setSections(list) {
      targets = list ?? [];
      active = -1;
      schedule();
    },
  };
}
