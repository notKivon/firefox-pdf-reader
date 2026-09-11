// Viewer entry point: boots the PDF pane and wires the reading chrome.
import { createPdfView } from "./pdfview.js";
import { initTheme } from "./theme.js";

const els = {
  container: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  status: document.getElementById("pdf-status"),
  statusTitle: document.querySelector("#pdf-status .status-title"),
  statusDetail: document.querySelector("#pdf-status .status-detail"),
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

function documentName(url) {
  try {
    const { pathname, host } = new URL(url);
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : host;
  } catch {
    return url;
  }
}

async function main() {
  await initTheme(els.theme);

  const file = new URLSearchParams(window.location.search).get("file");
  if (!file) {
    showStatus("No PDF requested", "Open a PDF link and Scholar Reader takes over from there.");
    return;
  }

  els.title.textContent = documentName(file);
  document.title = `${documentName(file)} — Scholar Reader`;
  showStatus("Loading…", documentName(file));

  const view = createPdfView({
    container: els.container,
    viewerEl: els.viewer,
    onPageChange: (page, total) => {
      els.page.textContent = `${page} / ${total}`;
    },
    onScaleChange: (scale) => {
      els.zoom.textContent = `${Math.round(scale * 100)}%`;
    },
  });

  els.zoomIn.addEventListener("click", () => view.zoomBy(1));
  els.zoomOut.addEventListener("click", () => view.zoomBy(-1));

  try {
    await view.load(file);
    hideStatus();
  } catch (err) {
    console.error("[scholar-reader] load failed", err);
    showStatus("This PDF could not be opened", err.message, true);
  }
}

main().catch((err) => {
  console.error("[scholar-reader] viewer failed to start", err);
  showStatus("Scholar Reader failed to start", String(err?.message ?? err), true);
});
