// Turning a list of headings plus a reading-order line list into section
// records, and the page-range fallback for when no headings were found.
export const MAX_SECTIONS = 40;
export const SCANNED_CHARS_PER_PAGE = 200;

// ~1200 tokens at the usual four-characters-per-token rule of thumb.
const CHUNK_CHARS = 4800;

// Body text is hyphenated at the line break; the text goes to a model, so the
// word is rejoined rather than left as "representa- tion".
function joinLines(lines) {
  let text = "";
  for (const line of lines) {
    if (!text) {
      text = line.str;
      continue;
    }
    if (/[\p{Ll}]-$/u.test(text)) text = text.slice(0, -1) + line.str;
    else text += " " + line.str;
  }
  return text.trim();
}

const isReferences = (title) => {
  const text = title.trim().toLowerCase().replace(/[:.]+$/, "")
    .replace(/^(\d{1,2}(\.\d{1,2})*|[ivxl]{1,5})[.)]?\s+/, "");
  return text === "references" || text === "bibliography";
};

// What a section keeps of each of its body lines, so a bullet can be located
// against the paper itself later (viewer/locate.js). Only position and text —
// the runs, fonts and item boxes stay behind, because nothing downstream needs
// them and this list travels with the section.
//
// It is NEVER sent to a model and never reaches the wire: `outline-pane.js`
// strips it at the send boundary, and a test asserts that. The model payload is
// `text` and nothing else.
const lineRecords = (lines) =>
  lines
    .filter((line) => line.str.trim())
    .map((line) => ({ page: line.page, y: line.pdfY, height: line.height, str: line.str }));

/**
 * Sections run from one heading to the next. Extraction stops at the
 * References/Bibliography heading and everything from there on is discarded —
 * reference lists are never sent to a model.
 *
 * @param headings {{index, line, title}[]} in reading order
 * @param lines    the document's lines in reading order
 */
export function buildSections(headings, lines) {
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const { index, line, title } = headings[i];
    if (isReferences(title)) break;
    const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    const body = lines.slice(index + 1, end);
    // `text` is empty for a parent heading whose first subsection follows it
    // immediately ("3. Deep Residual Learning", then "3.1. Residual Learning").
    // These are kept: they carry the paper's structure, and dropping them makes
    // the outline read as though the grouping did not exist. Step 7 must skip
    // the model call for a section with no text rather than send an empty one.
    const text = joinLines(body);
    sections.push({
      title: title.trim(),
      page: line.page,
      // PDF user space, for scrollPageIntoView.
      y: line.pdfY,
      text,
      lines: lineRecords(body),
    });
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

// No headings survived detection. Chunk the body by size instead of giving up:
// a degraded outline beats an error.
export function chunkSections(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (!current) current = { lines: [], page: line.page, y: line.pdfY, lastPage: line.page };
    current.lines.push(line);
    current.lastPage = line.page;
    if (joinLines(current.lines).length >= CHUNK_CHARS) {
      sections.push(finishChunk(current));
      current = null;
    }
  }
  if (current?.lines.length) sections.push(finishChunk(current));
  return sections;
}

function finishChunk(chunk) {
  const span = chunk.page === chunk.lastPage ? `Page ${chunk.page}` : `Pages ${chunk.page}–${chunk.lastPage}`;
  return {
    title: span,
    page: chunk.page,
    y: chunk.y,
    text: joinLines(chunk.lines),
    lines: lineRecords(chunk.lines),
  };
}
