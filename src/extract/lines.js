// Line assembly: items sharing a baseline become one line of text.
const SPACE_GAP = 0.2; // × item height; a wider gap than this implies a space

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

// Grouped on the baseline the line started at, so a superscript or an inline
// formula joins its line instead of drifting the whole line downward.
export function groupLines(items, tolerance, { column = 0, pageNumber = 0 } = {}) {
  const sorted = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  const groups = [];
  let current = null;
  for (const item of sorted) {
    if (!current || Math.abs(item.y - current.y) > tolerance) {
      current = { y: item.y, items: [item] };
      groups.push(current);
    } else {
      current.items.push(item);
    }
  }
  return groups.map((group) => finishLine(group, column, pageNumber)).filter((line) => line.str);
}
