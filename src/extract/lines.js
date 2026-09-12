// Line assembly: items sharing a baseline become one line of text.
const SPACE_GAP = 0.2; // × item height; a wider gap than this implies a space

// A run markedly shorter than the rest of its line is a super/subscript rather
// than a line of its own: 7pt against 10pt body text is the usual ratio.
const SCRIPT_HEIGHT_RATIO = 0.85;
// How much further off the baseline such a run may sit and still belong to the
// line. 1.6 × 0.4 = 0.64 × body height, comfortably inside the ~1.1 × body of
// real line spacing, so two body lines can never merge.
const SCRIPT_REACH = 1.6;

// pdf.js emits a run per style change, and whether a run already carries its
// trailing space is inconsistent. Reconstruct spacing from geometry instead.
function joinItems(items) {
  let str = "";
  let prevRight = null;
  for (const item of items) {
    const needsSpace =
      prevRight !== null &&
      item.x - prevRight > SPACE_GAP * (item.height || 1) &&
      !/\s$/.test(str) &&
      !/^\s/.test(item.str);
    str += (needsSpace ? " " : "") + item.str;
    prevRight = item.x + item.width;
  }
  return str.replace(/\s+/g, " ").trim();
}

function finishLine(group, column, pageNumber) {
  const items = group.items.sort((p, q) => p.x - q.x);
  let height = 0;
  let right = -Infinity;
  for (const item of items) {
    if (item.height > height) height = item.height;
    const edge = item.x + item.width;
    if (edge > right) right = edge;
  }
  return {
    str: joinItems(items),
    x: items[0].x,
    right,
    y: group.y,
    height,
    // The baseline in PDF user space — what scrollPageIntoView's XYZ wants.
    pdfY: items[0].pdfY,
    fontName: items[0].fontName,
    fontFamily: items[0].fontFamily ?? "",
    column,
    page: pageNumber,
    items,
  };
}

// Whether `item` belongs to the line `group` has started.
//
// The plain case is a shared baseline within tolerance. The other case is a
// super/subscript, which sits off the baseline by more than the tolerance and
// still belongs to the line — identified by being markedly smaller than the
// line's body text. The size test looks at both directions because items are
// sorted by y: a raised superscript opens the group before the body text it
// belongs to ever arrives, so the *group* is the small one half the time.
function joins(item, group, tolerance) {
  if (Math.abs(item.y - group.y) <= tolerance) return true;
  const small = Math.min(item.height, group.height);
  const large = Math.max(item.height, group.height);
  if (!large || small >= large * SCRIPT_HEIGHT_RATIO) return false;
  return Math.abs(item.y - group.y) <= tolerance * SCRIPT_REACH;
}

// Grouped on the line's *body* baseline, so a superscript or an inline formula
// joins its line instead of splitting it.
//
// Anchoring on the first item's y instead — which is what this did until a real
// paper showed it up — strands subscripts as lines of their own: sorting by y
// puts a raised superscript first, and a subscript on the same visual line is
// then further from that anchor than the tolerance allows. The stranded run
// becomes a line in its own right and lands in the text in the wrong place.
export function groupLines(items, tolerance, { column = 0, pageNumber = 0 } = {}) {
  const sorted = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  const groups = [];
  let current = null;
  for (const item of sorted) {
    if (current && joins(item, current, tolerance)) {
      current.items.push(item);
      // The line's baseline is its body text's, never that of whichever run
      // happened to sort first.
      if (item.height > current.height) {
        current.y = item.y;
        current.height = item.height;
      }
    } else {
      current = { y: item.y, height: item.height, items: [item] };
      groups.push(current);
    }
  }
  return groups.map((group) => finishLine(group, column, pageNumber)).filter((line) => line.str);
}
