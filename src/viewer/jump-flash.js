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
 * @param {number} [yEnd] the baseline of the last line to cover, for a bullet
 *   marking the sentences it restates rather than the heading above them
 * @param {number} [lineHeight] the matched text's own height, in PDF points
 */
export function flashAt(pageView, y, yEnd, lineHeight) {
  if (!pageView?.div || !pageView.viewport || typeof y !== "number") return;

  const scale = pageView.viewport.scale || 1;
  const [, top] = pageView.viewport.convertToViewportPoint(0, y);
  // A heading's band is a fixed height. A located span is as tall as the text
  // it covers, so the reader can see where the bullet's words actually are:
  // +y is up in PDF space, so the LAST line has the smaller y and the larger
  // viewport top.
  const band0 = BAND_POINTS * scale;
  let bandTop = Math.max(0, top - band0 * 0.85);
  let height = band0;
  if (typeof yEnd === "number") {
    const [, bottom] = pageView.viewport.convertToViewportPoint(0, yEnd);
    const lead = (lineHeight ?? BAND_POINTS * 0.5) * scale;
    bandTop = Math.max(0, top - lead * 1.05);
    height = Math.max(lead, bottom - top + lead * 1.35);
  }

  // Clicking three bullets of one section should not stack three bands.
  for (const old of pageView.div.querySelectorAll(".jump-flash")) old.remove();

  const band = document.createElement("div");
  band.className = "jump-flash";
  band.style.top = `${bandTop}px`;
  band.style.height = `${height}px`;
  const remove = () => band.remove();
  band.addEventListener("animationend", remove);
  // For the cases where the animation never fires at all — a backgrounded tab,
  // or a page pdf.js re-renders out from under it.
  setTimeout(remove, LIFETIME_MS);
  pageView.div.append(band);
}
