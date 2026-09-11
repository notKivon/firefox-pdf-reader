// Step 5/6 debug panel: shows the detected column layout and the reading order
// the extractor produced, so a bad layout is diagnosable rather than mysterious.
// Built with DOM calls rather than innerHTML — the CSP allows it either way,
// but page text is untrusted input and this keeps it inert.
const SCANNED_CHARS_PER_PAGE = 200;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createDebugPane({ root, onJump }) {
  root.replaceChildren();
  const heading = el("h2", "debug-heading", "Extraction");
  const status = el("p", "debug-status", "Reading the text layer…");
  const stats = el("dl", "debug-stats");
  const sections = el("div", "debug-sections");
  const pages = el("div", "debug-pages");
  root.append(heading, status, stats, sections, pages);

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
    row.append(badge, el("span", "debug-text", line.str));
    row.addEventListener("click", () => onJump?.({ page: line.page, y: line.pdfY }));
    return row;
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

    if (result?.scanned || charsPerPage < SCANNED_CHARS_PER_PAGE) {
      const warn = el(
        "p",
        "debug-warning",
        `Only ${Math.round(charsPerPage)} characters per page: this looks like a scanned PDF, ` +
          "so there is no text layer to outline. OCR is out of scope.",
      );
      root.insertBefore(warn, sections);
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

  return { progress, render, fail };
}
