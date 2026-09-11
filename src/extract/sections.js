// Heading detection and section assembly.
//
// Three paths, in order of trust: the PDF's own bookmarks, heading heuristics
// over the text layer, and a page-range chunking fallback. A degraded outline
// beats an error.
import { MAX_SECTIONS, SCANNED_CHARS_PER_PAGE, buildSections, chunkSections } from "./assemble.js";

// SPEC's vocabulary, matched case-insensitively and allowing a trailing colon.
const VOCABULARY = [
  "abstract", "introduction", "background", "related work", "preliminaries",
  "method", "methods", "methodology", "materials", "model", "data",
  "experiments", "experimental setup", "evaluation", "results", "analysis",
  "discussion", "limitations", "future work", "conclusion", "conclusions",
  "references", "bibliography", "appendix", "acknowledgements", "acknowledgments",
];

const MAX_HEADING_CHARS = 80;
const HEADING_HEIGHT_RATIO = 1.1;
// A heading is never set smaller than body text. Without this floor the bold
// tick labels and legends inside plots pass every other test — "0.6
// SGDNesterov+dropout" and "10 10 20-layer" are chart furniture, at 5-7pt
// against a 10pt body.
const MIN_HEADING_HEIGHT_RATIO = 0.95;

// Tightened from SPEC's /^(\d+(\.\d+)*|[IVXL]+)[.)\s]/, which matches the
// citation years that begin a wrapped body line ("2018). These include …") and
// percentages ("80.5% (7.7% point …"). Section numbers are one or two digits
// per level and are followed by a space, optionally after a dot or paren.
const NUMBER_PREFIX = /^(\d{1,2}(\.\d{1,2}){0,3}|[IVXL]{1,5})[.)]?\s+\S/;

// Table rows and stray math survive the prefix test ("94.9 60.5 86.5 89.3").
// A heading has a word in it.
const HAS_WORD = /\p{L}{2,}/u;

const normalize = (str) => str.trim().toLowerCase().replace(/[:.]+$/, "");

function inVocabulary(str) {
  const text = normalize(str).replace(NUMBER_PREFIX, "").trim() || normalize(str);
  return VOCABULARY.includes(text) || VOCABULARY.includes(normalize(str));
}

export function isReferencesHeading(title) {
  const text = normalize(title).replace(/^(\d{1,2}(\.\d{1,2})*|[IVXL]{1,5})[.)]?\s+/, "");
  return text === "references" || text === "bibliography";
}

// The cutoff is applied to the line stream, not to the assembled sections, so
// it holds on every path. Bookmarks routinely omit a References entry, and
// without this the final bookmarked section swallows the whole bibliography.
//
// Deliberately not gated on the heading test: a line that reads exactly
// "References" and nothing else is the heading, whatever face it is set in.
function truncateAtReferences(lines) {
  const cut = lines.findIndex((line) => line.str.length < 40 && isReferencesHeading(line.str));
  return cut < 0 ? lines : lines.slice(0, cut);
}

// SPEC's rule, with "set in a face other than the body face" standing in for
// the bold font-name test pdf.js cannot answer. See modalFontName().
export function isHeading(line, { bodyHeight, bodyFont }) {
  if (line.str.length >= MAX_HEADING_CHARS || !HAS_WORD.test(line.str)) return false;
  if (line.height < MIN_HEADING_HEIGHT_RATIO * bodyHeight) return false;
  const distinguished =
    line.height > HEADING_HEIGHT_RATIO * bodyHeight || (bodyFont && line.fontName !== bodyFont);
  if (!distinguished) return false;
  return NUMBER_PREFIX.test(line.str) || inVocabulary(line.str);
}

// Bookmarks are a flat list of {title, page, y} once nested items are walked
// and each destination resolved to a page index.
async function bookmarkHeadings(pdfDoc) {
  let outline;
  try {
    outline = await pdfDoc.getOutline();
  } catch {
    return [];
  }
  if (!outline?.length) return [];

  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      flat.push(node);
      if (node.items?.length) walk(node.items);
    }
  };
  walk(outline);

  const resolved = [];
  for (const node of flat) {
    if (!node.title?.trim()) continue;
    try {
      const dest = typeof node.dest === "string" ? await pdfDoc.getDestination(node.dest) : node.dest;
      if (!Array.isArray(dest) || !dest[0]) continue;
      const index =
        typeof dest[0] === "object" ? await pdfDoc.getPageIndex(dest[0]) : Number(dest[0]);
      if (!Number.isInteger(index)) continue;
      // XYZ destinations carry y at index 3; others (Fit, FitH) may not.
      const y = typeof dest[3] === "number" ? dest[3] : null;
      resolved.push({ title: node.title.trim(), page: index + 1, y });
    } catch {
      // One unresolvable bookmark must not lose the rest.
    }
  }
  resolved.sort((a, b) => a.page - b.page || (b.y ?? 0) - (a.y ?? 0));
  return resolved;
}

function headingLines(lines, stats) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i], stats)) found.push({ index: i, line: lines[i] });
  }
  return found;
}

// Anchors a bookmark onto the line that starts its section: the first line at
// or below the bookmark's y on its page, in reading order.
function anchorBookmarks(bookmarks, lines) {
  const anchored = [];
  for (const mark of bookmarks) {
    let index = lines.findIndex(
      (line) => line.page === mark.page && (mark.y === null || line.pdfY <= mark.y + 1),
    );
    if (index < 0) index = lines.findIndex((line) => line.page >= mark.page);
    if (index < 0) continue;
    anchored.push({ index, line: lines[index], title: mark.title });
  }
  return anchored;
}

/**
 * @returns {{sections, source, scanned, bodyHeight, bodyFont, headingCount}}
 */
export async function extractSections(pdfDoc, laid, { bodyHeight, bodyFont, charsPerPage }) {
  const all = [];
  for (const page of laid.pages) all.push(...page.lines);
  const lines = truncateAtReferences(all);

  // A scan has no text layer to work with. Say so and make no model call;
  // OCR is out of scope.
  if (charsPerPage < SCANNED_CHARS_PER_PAGE) {
    return { sections: [], source: "scanned", scanned: true, headingCount: 0 };
  }

  const bookmarks = anchorBookmarks(await bookmarkHeadings(pdfDoc), lines);
  // One bookmark yields one section spanning the whole paper, which is no more
  // useful than no outline at all — fall through to the heuristics instead.
  if (bookmarks.length >= 2) {
    const sections = buildSections(bookmarks, lines);
    if (sections.length >= 2) {
      return { sections, source: "bookmarks", scanned: false, headingCount: bookmarks.length };
    }
  }

  const headings = headingLines(lines, { bodyHeight, bodyFont });
  const sections = buildSections(
    headings.map((h) => ({ ...h, title: h.line.str })),
    lines,
  );
  if (sections.length >= 2) {
    return { sections, source: "headings", scanned: false, headingCount: headings.length };
  }

  return {
    sections: chunkSections(lines).slice(0, MAX_SECTIONS),
    source: "chunks",
    scanned: false,
    headingCount: headings.length,
  };
}

export { truncateAtReferences };
