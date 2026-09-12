// The arrival marker for a jump: a band over the heading that fades out.
//
// Its own module rather than more of pdfview.js — nothing else in that file
// touches page DOM, and this is purely an affordance. If it cannot place itself
// the jump still happened, so every failure here is silent by design.
const LIFETIME_MS = 1400;

// Roughly a heading's own height at 100%, scaled with the page.
const BAND_POINTS = 26;

/**
 * @param {{div: HTMLElement, viewport: object}} pageView a pdf.js page view
 * @param {number} y the target's PDF-space y (a heading baseline)
 */
export function flashAt(pageView, y) {
  if (!pageView?.div || !pageView.viewport || typeof y !== "number") return;

  const [, top] = pageView.viewport.convertToViewportPoint(0, y);
  const height = BAND_POINTS * (pageView.viewport.scale || 1);

  // Clicking three bullets of one section should not stack three bands.
  for (const old of pageView.div.querySelectorAll(".jump-flash")) old.remove();

  const band = document.createElement("div");
  band.className = "jump-flash";
  // `y` is the baseline, so the band sits mostly above it.
  band.style.top = `${Math.max(0, top - height * 0.85)}px`;
  band.style.height = `${height}px`;
  const remove = () => band.remove();
  band.addEventListener("animationend", remove);
  // For the cases where the animation never fires at all — a backgrounded tab,
  // or a page pdf.js re-renders out from under it.
  setTimeout(remove, LIFETIME_MS);
  pageView.div.append(band);
}
