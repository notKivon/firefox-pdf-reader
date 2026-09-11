// pdf.js PDFViewer setup: document loading, zoom, and section scrolling.
import { pdfjsLib, EventBus, PDFLinkService, PDFViewer } from "./pdfjs.js";

const { getDocument, GlobalWorkerOptions, AnnotationMode } = pdfjsLib;

const asset = (path) => browser.runtime.getURL(path);

GlobalWorkerOptions.workerSrc = asset("pdf.worker.mjs");

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

async function fetchPdf(url) {
  const host = new URL(url).host;
  let response;
  try {
    // Extension pages inherit host_permissions, so this cross-origin fetch is
    // not subject to CORS. Cookies go along for paywalled publisher PDFs.
    response = await fetch(url, { credentials: "include" });
  } catch (cause) {
    throw new Error(`Could not reach ${host}. The PDF was not downloaded.`, { cause });
  }
  if (!response.ok) {
    throw new Error(`${host} returned HTTP ${response.status} for this PDF.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createPdfView({ container, viewerEl, onPageChange, onScaleChange }) {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const pdfViewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    annotationMode: AnnotationMode.ENABLE,
    imageResourcesPath: asset("images/"),
  });
  linkService.setViewer(pdfViewer);

  let pdfDocument = null;

  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
    onPageChange?.(pdfViewer.currentPageNumber, pdfViewer.pagesCount);
  });
  eventBus.on("pagechanging", (e) => {
    onPageChange?.(e.pageNumber, pdfViewer.pagesCount);
  });
  eventBus.on("scalechanging", (e) => onScaleChange?.(e.scale));

  // "page-width" resolves to a fixed scale at assignment time, so a pane resize
  // has to re-assign it. This is what pdf.js's own viewer does on resize.
  const resizeObserver = new ResizeObserver(() => {
    if (!pdfDocument) return;
    const value = pdfViewer.currentScaleValue;
    if (value === "auto" || value === "page-width" || value === "page-fit") {
      pdfViewer.currentScaleValue = value;
    }
    pdfViewer.update();
  });
  resizeObserver.observe(container);

  async function load(url) {
    const bytes = await fetchPdf(url);
    let doc;
    try {
      doc = await getDocument({
        data: bytes,
        cMapUrl: asset("cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: asset("standard_fonts/"),
        iccUrl: asset("iccs/"),
        wasmUrl: asset("wasm/"),
      }).promise;
    } catch (cause) {
      throw new Error(`This file could not be parsed as a PDF (${cause.name}).`, { cause });
    }
    pdfDocument = doc;
    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    return doc;
  }

  // Bullets carry {page, y} in PDF user space; XYZ with a null left keeps the
  // current horizontal offset and only scrolls vertically.
  function scrollToSection({ page, y }) {
    if (!pdfDocument) return;
    const pageNumber = Math.min(Math.max(page ?? 1, 1), pdfViewer.pagesCount);
    pdfViewer.scrollPageIntoView({
      pageNumber,
      destArray: [null, { name: "XYZ" }, null, y ?? null, null],
      allowNegativeOffset: true,
    });
  }

  function zoomBy(direction) {
    const current = pdfViewer.currentScale;
    const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
    const next = steps.find((s) => (direction > 0 ? s > current + 0.001 : s < current - 0.001));
    if (next) pdfViewer.currentScaleValue = String(next);
  }

  function destroy() {
    resizeObserver.disconnect();
    pdfDocument?.destroy();
    pdfDocument = null;
  }

  return { load, scrollToSection, zoomBy, destroy, eventBus, get document() { return pdfDocument; } };
}
