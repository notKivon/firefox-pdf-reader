// Column clustering and reading-order assembly.
//
// Columns are detected from item x-midpoints first; lines are grouped *within*
// a column afterwards. Grouping lines across the whole page first would fuse
// the left and right columns of a two-column paper into single lines, which is
// the exact failure this module exists to prevent.
import { modalHeight } from "./textlayer.js";
import { groupLines } from "./lines.js";

// SPEC's acceptance test for a two-column split.
const MIN_CENTRE_GAP = 0.15; // × page width
const MIN_CLUSTER_SHARE = 0.2; // × item count
const MIN_ITEMS_FOR_SPLIT = 20;

// Added after the specified test alone accepted single-column papers (see the
// straddle note in PROGRESS.md). A run that spans the proposed gutter is proof
// there is no gutter there; a true two-column page has almost none.
const MAX_STRADDLE_SHARE = 0.05;
const MIN_TWO_COLUMN_PAGES = 0.5; // × pages that must vote two-column

const LINE_TOLERANCE = 0.4; // × body height

// 1-D Lloyd's algorithm seeded at the extremes; converges in a few passes on a
// distribution this simple.
function twoMeans(values) {
  let a = Infinity;
  let b = -Infinity;
  for (const v of values) {
    if (v < a) a = v;
    if (v > b) b = v;
  }
  for (let pass = 0; pass < 24; pass++) {
    let sumA = 0;
    let nA = 0;
    let sumB = 0;
    let nB = 0;
    for (const v of values) {
      if (Math.abs(v - a) <= Math.abs(v - b)) {
        sumA += v;
        nA += 1;
      } else {
        sumB += v;
        nB += 1;
      }
    }
    if (!nA || !nB) return null;
    const nextA = sumA / nA;
    const nextB = sumB / nB;
    const settled = Math.abs(nextA - a) < 1e-6 && Math.abs(nextB - b) < 1e-6;
    a = nextA;
    b = nextB;
    if (settled) return { a, b, counts: [nA, nB] };
  }
  return null;
}

const straddles = (item, boundary) => item.x < boundary && item.x + item.width > boundary;

function straddleShare(items, boundary) {
  let n = 0;
  for (const item of items) if (straddles(item, boundary)) n += 1;
  return n / items.length;
}

// → { count, centres, boundary, straddle }. `boundary` is the gutter's x.
export function detectColumns(items, pageWidth) {
  const single = { count: 1, centres: [], boundary: Infinity, straddle: 0 };
  if (items.length < MIN_ITEMS_FOR_SPLIT || !pageWidth) return single;

  const split = twoMeans(items.map((item) => item.x + item.width / 2));
  if (!split) return single;

  const [left, right] = split.a <= split.b ? [split.a, split.b] : [split.b, split.a];
  const floor = MIN_CLUSTER_SHARE * items.length;
  if (right - left <= MIN_CENTRE_GAP * pageWidth) return single;
  if (split.counts[0] < floor || split.counts[1] < floor) return single;

  const boundary = (left + right) / 2;
  const straddle = straddleShare(items, boundary);
  if (straddle > MAX_STRADDLE_SHARE) return single;

  return { count: 2, centres: [left, right], boundary, straddle };
}

// Layout is a property of the paper, not the page: a two-column paper still has
// pages that are one full-width table, and a single-column paper still has
// pages of centred equations that cluster into two. Per-page verdicts overlap
// badly; the majority vote across pages separates cleanly.
export function columnVerdict(pages) {
  let votes = 0;
  let boundarySum = 0;
  for (const page of pages) {
    const columns = detectColumns(page.items, page.width);
    if (columns.count === 2) {
      votes += 1;
      boundarySum += columns.boundary / page.width;
    }
  }
  if (!pages.length || votes < MIN_TWO_COLUMN_PAGES * pages.length) {
    return { count: 1, boundaryRatio: 0, votes };
  }
  return { count: 2, boundaryRatio: boundarySum / votes, votes };
}

// Full-width lines split the page into bands. Within a band the left column is
// read before the right; the band itself is read in document order, so a
// spanning title or a full-width table lands where a reader meets it rather
// than being swept into whichever column its midpoint happened to fall in.
function emitBands(spanning, columns) {
  const bands = [...spanning].sort((p, q) => p.y - q.y);
  const cursors = columns.map(() => 0);
  const out = [];
  // groupLines already returns each column top to bottom, so a cursor per
  // column is enough to walk them in step with the bands.
  const drain = (limit) => {
    columns.forEach((lines, c) => {
      while (cursors[c] < lines.length && lines[cursors[c]].y < limit) out.push(lines[cursors[c]++]);
    });
  };
  for (const band of bands) {
    drain(band.y);
    out.push(band);
  }
  drain(Infinity);
  return out;
}

export function layoutPage(page, { bodyHeight, columnCount, boundaryRatio } = {}) {
  const body = bodyHeight || modalHeight(page.items) || 10;
  const tolerance = LINE_TOLERANCE * body;
  const boundary = boundaryRatio ? boundaryRatio * page.width : page.width / 2;
  const twoColumn = columnCount === 2 && page.items.length >= MIN_ITEMS_FOR_SPLIT;

  if (!twoColumn) {
    return {
      pageNumber: page.pageNumber,
      columnCount: 1,
      boundary: null,
      lines: groupLines(page.items, tolerance, { pageNumber: page.pageNumber }),
    };
  }

  const buckets = [[], [], []]; // left, right, spanning
  for (const item of page.items) {
    if (straddles(item, boundary)) buckets[2].push(item);
    else buckets[item.x + item.width / 2 < boundary ? 0 : 1].push(item);
  }

  const opts = { pageNumber: page.pageNumber };
  const columns = [
    groupLines(buckets[0], tolerance, { ...opts, column: 0 }),
    groupLines(buckets[1], tolerance, { ...opts, column: 1 }),
  ];
  const spanning = groupLines(buckets[2], tolerance, { ...opts, column: -1 });

  return {
    pageNumber: page.pageNumber,
    columnCount: 2,
    boundary,
    lines: emitBands(spanning, columns),
  };
}

// Body height is computed across every page, not per page, so one title-heavy
// page cannot redefine what body text is.
export function layoutDocument(pages) {
  const all = [];
  for (const page of pages) all.push(...page.items);
  const bodyHeight = modalHeight(all);
  const verdict = columnVerdict(pages);
  const opts = { bodyHeight, columnCount: verdict.count, boundaryRatio: verdict.boundaryRatio };
  return { bodyHeight, verdict, pages: pages.map((page) => layoutPage(page, opts)) };
}
