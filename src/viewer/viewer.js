// Viewer entry point: boots the PDF pane and wires the reading chrome.
import { createPdfView } from "./pdfview.js";
import { initTheme } from "./theme.js";
import { initPaneResize } from "./pane-resize.js";
import { createToolbarFields } from "./toolbar-fields.js";
import { recordOpen, readingPosition, sha256Hex } from "../store/docs.js";
import { charsPerPage, extractPages, modalFontName } from "../extract/textlayer.js";
import { layoutDocument } from "../extract/columns.js";
import { extractSections } from "../extract/sections.js";
import { initActions } from "./actions.js";
import { createDebugPane } from "./debug-pane.js";
import { createOutlinePane } from "./outline-pane.js";
import { trackReadingPosition } from "./reading-position.js";
import { trackCurrentSection } from "./scroll-spy.js";
import { fromFile, fromUrl, nameOf, nextPickedFile, requestedUrl } from "./source.js";

const $ = (id) => document.getElementById(id);
const els = {
  container: $("viewerContainer"),
  viewer: $("viewer"),
  status: $("pdf-status"),
  statusTitle: document.querySelector("#pdf-status .status-title"),
  statusDetail: document.querySelector("#pdf-status .status-detail"),
  statusOpenLocal: $("status-open-local"),
  localFile: $("local-file"),
  note: $("pane-note"),
  outline: $("outline-root"),
  debug: $("debug-pane"),
  title: $("doc-title"),
  pageInput: $("page-input"),
  pageTotal: $("page-total"),
  zoomInput: $("zoom-input"),
  resizer: $("pane-resizer"),
  pane: $("outline-pane"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  fitButton: $("fit-width"),
  theme: $("theme-toggle"),
  openLocal: $("open-local"),
  nativeViewer: $("native-viewer"),
  settings: $("open-settings"),
};

function showStatus(title, detail = "", isError = false) {
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
  els.status.classList.toggle("is-error", isError);
  els.status.hidden = false;
}

// Non-fatal problems: the paper still reads, so they belong beside the outline
// rather than over the page.
function showNote(text) {
  els.note.textContent = text;
  els.note.hidden = false;
}

function setDocumentTitle(name) {
  els.title.textContent = name;
  document.title = `${name} — Scholar Reader`;
}

// Extraction is its own failure domain too: a paper that defeats the text layer
// must still render and still scroll.
async function runExtraction(pane, pdfDoc) {
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

/**
 * No `?file=`: an empty viewer, opened from the toolbar button. The picker is
 * the way in, and a failed read offers it again rather than ending the page.
 */
async function pickLocal() {
  els.statusOpenLocal.hidden = false;
  for (;;) {
    const file = await nextPickedFile(els.localFile, [els.statusOpenLocal, els.openLocal]);
    showStatus("Loading…", file.name);
    try {
      return await fromFile(file);
    } catch (err) {
      showStatus("That file could not be opened", `${err.message} Choose another.`, true);
    }
  }
}

function offerAnotherFile() {
  const again = () => window.location.reload();
  els.statusOpenLocal.textContent = "Choose another PDF…";
  els.statusOpenLocal.hidden = false;
  els.statusOpenLocal.addEventListener("click", again);
  els.openLocal.addEventListener("click", again);
}

async function main() {
  // Both before the paper loads: a pane width applied afterwards would re-fit
  // every page and move the reading position just restored.
  await Promise.all([initTheme(els.theme), initPaneResize({ handle: els.resizer, pane: els.pane })]);
  const actions = initActions({ ...els, onNote: showNote });

  const url = requestedUrl();
  let source;
  if (url) {
    setDocumentTitle(nameOf(url));
    showStatus("Loading…", nameOf(url));
  } else {
    showStatus(
      "Open a PDF",
      "PDF links open here on their own. For a file on this computer, choose it below — Firefox does not let extensions open file:// PDFs directly.",
    );
  }

  // pdf.js reports page and scale only after load, by which time `fields` exists.
  const view = createPdfView({
    container: els.container,
    viewerEl: els.viewer,
    onPageChange: (page, total) => fields.setPage(page, total),
    onScaleChange: (scale, preset) => fields.setScale(scale, preset),
  });
  const fields = createToolbarFields({ ...els, view });

  els.zoomIn.addEventListener("click", () => view.zoomBy(1));
  els.zoomOut.addEventListener("click", () => view.zoomBy(-1));

  let doc;
  let hash;
  try {
    source = url ? await fromUrl(url) : await pickLocal();
    setDocumentTitle(source.name);
    // Hashed before loading: pdf.js may transfer the buffer to its worker and
    // leave it detached.
    hash = await sha256Hex(source.bytes);
    doc = await view.load(source.bytes);
    els.status.hidden = true;
  } catch (err) {
    console.error("[scholar-reader] load failed", err);
    showStatus("This PDF could not be opened", err.message, true);
    // The browser's own viewer may manage what this one could not; a picked
    // file it rejects gets the picker again, on a clean page.
    if (url) actions.setSource({ url, local: false });
    else offerAnotherFile();
    return;
  }
  actions.setSource(source);

  // The two halves of section jumping, and each needs the other: the pane sends
  // the reader to a place in the paper, and where the reader is sends the pane
  // back a section. The spy is built first and reaches the pane through the
  // binding below, which is assigned before any scroll event can fire.
  let outlinePane;
  const spy = trackCurrentSection({
    container: els.container,
    view,
    onChange: (index) => outlinePane?.setActive(index),
  });
  const debugPane = createDebugPane({ root: els.debug, onJump: (target) => view.scrollToSection(target) });
  outlinePane = createOutlinePane({
    root: els.outline,
    onJump: (target) => view.scrollToSection(target),
    onSections: (targets) => spy.setSections(targets),
    onReady: () => debugPane.collapse(),
  });
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "outline-progress") outlinePane.progress(message);
  });

  // Started before the store round-trip rather than after it: extraction is the
  // slow part, and the outline needs its sections before it needs the title.
  const extraction = runExtraction(debugPane, doc);

  // Identity and history are a separate failure domain from rendering: a broken
  // IndexedDB must not cost the reader the paper.
  let meta = { title: source.name, pageCount: doc.numPages };
  try {
    const record = await recordOpen({ hash, url: source.url, pdfDoc: doc });
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
