// Viewer entry point: boots the PDF pane and wires the reading chrome.
import { createPdfView, fetchPdf } from "./pdfview.js";
import { initTheme } from "./theme.js";
import { recordOpen, readingPosition, sha256Hex } from "../store/docs.js";
import { charsPerPage, extractPages, modalFontName } from "../extract/textlayer.js";
import { layoutDocument } from "../extract/columns.js";
import { extractSections } from "../extract/sections.js";
import { createDebugPane } from "./debug-pane.js";
import { createOutlinePane } from "./outline-pane.js";
import { trackReadingPosition } from "./reading-position.js";

const els = {
  container: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  status: document.getElementById("pdf-status"),
  statusTitle: document.querySelector("#pdf-status .status-title"),
  statusDetail: document.querySelector("#pdf-status .status-detail"),
  note: document.getElementById("pane-note"),
  outline: document.getElementById("outline-root"),
  debug: document.getElementById("debug-pane"),
  title: document.getElementById("doc-title"),
  page: document.getElementById("page-indicator"),
  zoom: document.getElementById("zoom-level"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  theme: document.getElementById("theme-toggle"),
};

function showStatus(title, detail = "", isError = false) {
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
  els.status.classList.toggle("is-error", isError);
  els.status.hidden = false;
}

function hideStatus() {
  els.status.hidden = true;
}

// Non-fatal problems: the paper still reads, so they belong beside the outline
// rather than over the page.
function showNote(text) {
  els.note.textContent = text;
  els.note.hidden = false;
}

function documentName(url) {
  try {
    const { pathname, host } = new URL(url);
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : host;
  } catch {
    return url;
  }
}

function setDocumentTitle(name) {
  els.title.textContent = name;
  document.title = `${name} — Scholar Reader`;
}

// Extraction is its own failure domain too: a paper that defeats the text layer
// must still render and still scroll.
async function runExtraction(view, pdfDoc) {
  const pane = createDebugPane({
    root: els.debug,
    onJump: (target) => view.scrollToSection(target),
  });
  try {
    const pages = await extractPages(pdfDoc, { onPage: (_, done, total) => pane.progress(done, total) });
    const sideways = pages.reduce((n, page) => n + page.droppedSideways, 0);
    const laid = layoutDocument(pages);
    const chars = charsPerPage(pages);
    const result = await extractSections(pdfDoc, laid, {
      bodyHeight: laid.bodyHeight,
      bodyFont: modalFontName(pages),
      charsPerPage: chars,
    });
    pane.render(laid, chars, sideways, result);
    return result;
  } catch (err) {
    console.error("[scholar-reader] extraction failed", err);
    pane.fail(`The text layer could not be read: ${err.message}`);
  }
}

async function main() {
  await initTheme(els.theme);

  const file = new URLSearchParams(window.location.search).get("file");
  if (!file) {
    showStatus("No PDF requested", "Open a PDF link and Scholar Reader takes over from there.");
    return;
  }

  setDocumentTitle(documentName(file));
  showStatus("Loading…", documentName(file));

  const view = createPdfView({
    container: els.container,
    viewerEl: els.viewer,
    onPageChange: (page, total) => {
      els.page.textContent = `${page} / ${total}`;
    },
    onScaleChange: (scale) => {
      els.zoom.textContent = `${Math.round(scale * 100)}%`;
    },
  });

  els.zoomIn.addEventListener("click", () => view.zoomBy(1));
  els.zoomOut.addEventListener("click", () => view.zoomBy(-1));

  let doc;
  let hash;
  try {
    const bytes = await fetchPdf(file);
    // Hashed before loading: pdf.js may transfer the buffer to its worker and
    // leave it detached.
    hash = await sha256Hex(bytes);
    doc = await view.load(bytes);
    hideStatus();
  } catch (err) {
    console.error("[scholar-reader] load failed", err);
    showStatus("This PDF could not be opened", err.message, true);
    return;
  }

  const outlinePane = createOutlinePane({ root: els.outline });
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "outline-progress") outlinePane.progress(message);
  });

  // Started before the store round-trip rather than after it: extraction is the
  // slow part, and the outline needs its sections before it needs the title.
  const extraction = runExtraction(view, doc);

  // Identity and history are a separate failure domain from rendering: a broken
  // IndexedDB must not cost the reader the paper.
  let meta = { title: documentName(file), pageCount: doc.numPages };
  try {
    const record = await recordOpen({ hash, url: file, pdfDoc: doc });
    console.info(`[scholar-reader] document ${hash} — ${record.urls.length} url(s) on record`);
    setDocumentTitle(record.title);
    meta = { title: record.title, pageCount: record.pageCount };
    trackReadingPosition({ view, hash, container: els.container, position: readingPosition(record), onNote: showNote });
  } catch (err) {
    console.error("[scholar-reader] document store unavailable", err);
    showNote(`Reading position and outlines cannot be stored: ${err.message}`);
  }

  // Extraction gates the outline: the pane cannot say what would be sent until
  // it knows what the sections are.
  extraction
    .then((result) => {
      // No sections means no card and no spinner: the pane says why instead.
      if (result) outlinePane.start({ hash, meta, sections: result.sections, scanned: result.scanned });
      else outlinePane.fail("The text layer could not be read, so there is nothing to outline.");
    })
    .catch((err) => {
      console.error("[scholar-reader] extraction pane failed", err);
      outlinePane.fail(`The outline pane failed to start: ${err.message}`);
    });
}

main().catch((err) => {
  console.error("[scholar-reader] viewer failed to start", err);
  showStatus("Scholar Reader failed to start", String(err?.message ?? err), true);
});
