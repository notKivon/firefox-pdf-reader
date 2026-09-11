// Viewer entry point: boots the PDF pane and wires the reading chrome.
import { createPdfView, fetchPdf } from "./pdfview.js";
import { initTheme } from "./theme.js";
import { recordOpen, readingPosition, saveReadingPosition, sha256Hex } from "../store/docs.js";

const SAVE_DEBOUNCE_MS = 600;

const els = {
  container: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  status: document.getElementById("pdf-status"),
  statusTitle: document.querySelector("#pdf-status .status-title"),
  statusDetail: document.querySelector("#pdf-status .status-detail"),
  note: document.getElementById("pane-note"),
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

function debounce(fn, ms) {
  let timer = null;
  const run = () => {
    timer = null;
    fn();
  };
  const wrapped = () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };
  return wrapped;
}

function setDocumentTitle(name) {
  els.title.textContent = name;
  document.title = `${name} — Scholar Reader`;
}

// Restores where the reader left off, then keeps the record up to date.
function trackReadingPosition(view, hash, position) {
  const save = debounce(() => {
    saveReadingPosition(hash, view.position()).catch((err) => {
      console.warn("[scholar-reader] reading position not saved", err);
      showNote(`Reading position is not being saved: ${err.message}`);
    });
  }, SAVE_DEBOUNCE_MS);

  view.whenReady(() => {
    view.restorePosition(position);
    // Attached only after the restore, so the pristine top-of-document position
    // never overwrites the saved one.
    els.container.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", () => save.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") save.flush();
    });
  });
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

  // Identity and history are a separate failure domain from rendering: a broken
  // IndexedDB must not cost the reader the paper.
  try {
    const record = await recordOpen({ hash, url: file, pdfDoc: doc });
    console.info(`[scholar-reader] document ${hash} — ${record.urls.length} url(s) on record`);
    setDocumentTitle(record.title);
    trackReadingPosition(view, hash, readingPosition(record));
  } catch (err) {
    console.error("[scholar-reader] document store unavailable", err);
    showNote(`Reading position and outlines cannot be stored: ${err.message}`);
  }
}

main().catch((err) => {
  console.error("[scholar-reader] viewer failed to start", err);
  showStatus("Scholar Reader failed to start", String(err?.message ?? err), true);
});
