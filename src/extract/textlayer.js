// Text layer extraction: getTextContent() → items positioned in viewport space.
//
// Positions are run through the page's viewport transform so a rotated page
// still yields screen-reading coordinates (origin top-left, y increasing down).
// Each item also keeps its raw PDF-space baseline as `pdfY`, because that is
// what scrollPageIntoView's XYZ destination wants.
import { pdfjsLib } from "../viewer/pdfjs.js";

const { Util } = pdfjsLib;

// Height bucket for the modal-height statistic. Fine enough to tell 10pt body
// text from an 11pt heading, coarse enough that rounding noise doesn't split
// one font size across two buckets.
const HEIGHT_BUCKET = 0.1;

const isBlank = (str) => !str || !str.trim();

// pdf.js reports `width` as the advance along the text direction and `height`
// as the font height, both in PDF user space. Under a 90°/270° viewport those
// two swap which screen axis they lie on.
function extents(item, rotated) {
  const width = Math.abs(item.width);
  const height = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3]);
  return rotated ? { width: height, height: width } : { width, height };
}

// True when the run advances more vertically than horizontally on screen, i.e.
// it is sideways relative to the page: arXiv stamps, rotated table headers.
function isSideways(t) {
  return Math.abs(t[1]) > Math.abs(t[0]);
}

export async function extractPageItems(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const rotated = viewport.rotation % 180 !== 0;
  const content = await page.getTextContent();
  // `item.fontName` is an internal id ("g_d0_f1"); the real family, which is
  // where "Bold" shows up, only exists in the styles map.
  const styles = content.styles ?? {};

  const items = [];
  const sideways = [];
  for (const item of content.items) {
    // Marked-content boundaries have no `transform`; whitespace-only runs carry
    // no position information worth clustering.
    if (!item.transform || isBlank(item.str)) continue;
    const t = Util.transform(viewport.transform, item.transform);
    const { width, height } = extents(item, rotated);
    const record = {
      str: item.str,
      x: t[4],
      y: t[5],
      width,
      height,
      fontName: item.fontName ?? "",
      fontFamily: styles[item.fontName]?.fontFamily ?? "",
      hasEOL: !!item.hasEOL,
      pdfY: item.transform[5],
    };
    (isSideways(t) ? sideways : items).push(record);
  }

  // Sideways runs are dropped, but only as the minority: their baselines lie
  // across the body text's lines and would otherwise be spliced into them (an
  // arXiv stamp lands mid-paragraph). When sideways text is the majority the
  // page is genuinely rotated without declaring /Rotate, and dropping it would
  // throw the page away, so everything is kept and the mess stays visible.
  const majoritySideways = sideways.length > items.length;
  const kept = majoritySideways ? [...items, ...sideways] : items;

  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation: viewport.rotation,
    items: kept,
    droppedSideways: majoritySideways ? 0 : sideways.length,
  };
}

// Sequential on purpose: page order is the output order, and getTextContent
// already runs off-thread in the pdf.js worker. `onPage` lets the caller paint
// progressively instead of waiting for a 30-page paper to finish.
export async function extractPages(pdfDoc, { onPage } = {}) {
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await extractPageItems(pdfDoc, n);
    pages.push(page);
    onPage?.(page, pages.length, pdfDoc.numPages);
  }
  return pages;
}

// The most common item height, which for an academic paper is the body font.
// Deliberately a plain mode over items, as specified — not weighted by
// character count — so that step 6's body-size rule and this one agree.
export function modalHeight(items) {
  const counts = new Map();
  let best = 0;
  let bestCount = 0;
  for (const item of items) {
    if (!item.height) continue;
    const bucket = Math.round(item.height / HEIGHT_BUCKET) * HEIGHT_BUCKET;
    const count = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, count);
    if (count > bestCount || (count === bestCount && bucket < best)) {
      best = bucket;
      bestCount = count;
    }
  }
  return best;
}

// The font most of the document is set in, weighted by characters so a few
// long body runs outweigh many short ones.
//
// pdf.js never exposes a real font name — `styles[].fontFamily` is only ever
// "serif"/"sans-serif"/"monospace" — so SPEC's `/bold|black|semibold/i` test
// cannot be implemented. This is the same signal by another route: a heading is
// set in a face that is *not* the body face, whatever that face is called.
export function modalFontName(pages) {
  const chars = new Map();
  let best = "";
  let bestCount = 0;
  for (const page of pages) {
    for (const item of page.items) {
      const count = (chars.get(item.fontName) ?? 0) + item.str.length;
      chars.set(item.fontName, count);
      if (count > bestCount) {
        best = item.fontName;
        bestCount = count;
      }
    }
  }
  return best;
}

// Mean characters of extracted text per page. Under ~200 the document is a scan
// and step 6 refuses to send it to a model.
export function charsPerPage(pages) {
  if (!pages.length) return 0;
  let chars = 0;
  for (const page of pages) {
    for (const item of page.items) chars += item.str.length;
  }
  return chars / pages.length;
}
