// Step 5/6 debug panel: shows the detected column layout and the reading order
// the extractor produced, so a bad layout is diagnosable rather than mysterious.
import { el } from "./el.js";
import { UNRENDERABLE } from "../extract/normalize.js";

const SCANNED_CHARS_PER_PAGE = 200;

export function createDebugPane({ root, onJump }) {
  // One collapsible block, open while the text layer is read and folded away by
  // `collapse()` once an outline is on screen, so the outline leads the pane.
  const panel = el("details", "debug-panel");
  panel.open = true;
  const heading = el("summary", "debug-heading", "Extraction");
  const status = el("p", "debug-status", "Reading the text layer…");
  const stats = el("dl", "debug-stats");
  const sections = el("div", "debug-sections");
  const pages = el("div", "debug-pages");
  panel.append(heading, status, stats, sections, pages);
  root.replaceChildren(panel);

  function stat(label, value) {
    stats.append(el("dt", null, label), el("dd", null, String(value)));
  }

  function progress(pageNumber, total) {
    status.textContent = `Reading the text layer… page ${pageNumber} of ${total}`;
  }

  function fail(message) {
    status.textContent = message;
    status.classList.add("is-error");
  }

  function renderLine(line) {
    const row = el("button", "debug-line");
    row.type = "button";
    const label = line.column < 0 ? "▭" : line.column === 0 ? "L" : "R";
    const badge = el("span", "debug-col", label);
    badge.title = line.column < 0 ? "spans both columns" : `column ${line.column + 1}`;
    row.append(badge, renderText(line));
    row.addEventListener("click", () => onJump?.({ page: line.page, y: line.pdfY }));
    return row;
  }

  // Built from the line's runs rather than its flat string, so a superscript
  // sits where the paper put it instead of dropping to the baseline.
  function renderText(line) {
    const box = el("span", "debug-text");
    if (!line.runs?.length) {
      box.textContent = line.str;
      return box;
    }
    for (const run of line.runs) {
      box.append(el(run.script === "sup" ? "sup" : run.script === "sub" ? "sub" : "span", null, run.str));
    }
    return box;
  }

  // Characters no font can draw, so they reach the reader as boxes. They mean a
  // PDF font whose glyphs pdf.js could not map to Unicode at all. Named rather
  // than guessed at: the right substitution depends on which ones they are, and
  // inventing one would put text in the pane the paper does not contain.
  function renderUnrenderable(list) {
    const box = el("details", "debug-page");
    box.append(el("summary", null, `Unrenderable characters — ${list.length} distinct`));
    const rows = el("div", "debug-lines");
    for (const [ch, n] of list) {
      const row = el("div", "debug-line");
      const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      row.append(
        el("span", "debug-cp", `U+${cp}`),
        el("span", "debug-text", "no font draws this; pdf.js could not map the glyph"),
        el("span", "debug-size", String(n)),
      );
      rows.append(row);
    }
    box.append(rows);
    return box;
  }

  function renderPage(layout) {
    const box = el("details", "debug-page");
    const label =
      `Page ${layout.pageNumber} — ` +
      `${layout.columnCount === 2 ? "2 columns" : "1 column"}, ${layout.lines.length} lines`;
    box.append(el("summary", null, label));
    const list = el("div", "debug-lines");
    for (const line of layout.lines) list.append(renderLine(line));
    box.append(list);
    return box;
  }

  const SOURCE_LABEL = {
    bookmarks: "from the PDF's own bookmarks",
    headings: "from heading heuristics over the text layer",
    chunks: "no headings found — chunked by page range",
    scanned: "scanned PDF",
  };

  // Sections are what step 7 actually sends to a model, so the panel shows the
  // extracted title, where it starts and how much text came with it.
  function renderSections(result) {
    const box = el("details", "debug-page debug-sections-box");
    box.open = true;
    box.append(
      el("summary", null, `Sections — ${result.sections.length} ${SOURCE_LABEL[result.source] ?? result.source}`),
    );
    const list = el("div", "debug-lines");
    for (const section of result.sections) {
      const row = el("button", "debug-line");
      row.type = "button";
      row.append(
        el("span", "debug-col", `p${section.page}`),
        el("span", "debug-text", section.title),
        // An empty section is a parent heading whose subsection follows it
        // immediately; step 7 skips the model call rather than sending nothing.
        el("span", "debug-size", section.text.length ? `${section.text.length}` : "—"),
      );
      row.addEventListener("click", () => onJump?.({ page: section.page, y: section.y }));
      list.append(row);
    }
    box.append(list);
    sections.replaceChildren(box);
  }

  // `laid` is the whole document: the column verdict is a document-level vote,
  // so nothing can be laid out until every page has been read.
  function render({ bodyHeight, verdict, pages: laid }, charsPerPage, sideways = 0, result = null) {
    status.textContent =
      verdict.count === 2
        ? `Two-column layout (${verdict.votes} of ${laid.length} pages voted for it).`
        : `Single-column layout (${verdict.votes} of ${laid.length} pages clustered into two).`;

    stat("Pages", laid.length);
    stat("Body text height", `${bodyHeight.toFixed(1)} pt`);
    stat("Characters per page", Math.round(charsPerPage));
    stat("Lines", laid.reduce((n, page) => n + page.lines.length, 0));
    // Sideways runs are stamps and rotated headers; a surprising count here is
    // the first sign that a page was misread.
    if (sideways) stat("Sideways runs dropped", sideways);

    const counts = new Map();
    for (const page of laid) {
      for (const line of page.lines) {
        for (const ch of line.str.match(UNRENDERABLE) ?? []) counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    if (counts.size) {
      stat("Unrenderable characters", [...counts.values()].reduce((a, b) => a + b, 0));
      panel.insertBefore(renderUnrenderable([...counts].sort((a, b) => b[1] - a[1])), sections);
    }

    if (result?.scanned || charsPerPage < SCANNED_CHARS_PER_PAGE) {
      const warn = el(
        "p",
        "debug-warning",
        `Only ${Math.round(charsPerPage)} characters per page: this looks like a scanned PDF, ` +
          "so there is no text layer to outline. OCR is out of scope.",
      );
      panel.insertBefore(warn, sections);
    } else if (result) {
      stat("Sections", result.sections.length);
      renderSections(result);
    }

    // The first page is open because it is the one worth eyeballing first; the
    // rest stay collapsed so a 30-page paper does not bury the summary.
    laid.forEach((layout, index) => {
      const box = renderPage(layout);
      box.open = index === 0;
      pages.append(box);
    });
  }

  function collapse() {
    panel.open = false;
  }

  return { progress, render, fail, collapse };
}
