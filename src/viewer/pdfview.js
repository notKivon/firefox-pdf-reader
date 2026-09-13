// pdf.js PDFViewer setup: document loading, zoom, and section scrolling.
import { flashAt } from "./jump-flash.js";
import { pdfjsLib, EventBus, PDFLinkService, PDFViewer } from "./pdfjs.js";

const { getDocument, GlobalWorkerOptions, AnnotationMode } = pdfjsLib;

const asset = (path) => browser.runtime.getURL(path);

GlobalWorkerOptions.workerSrc = asset("pdf.worker.mjs");

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Air above a heading a jump lands on, in PDF points (~0.4in at 100%).
const SCROLL_TOP_MARGIN = 30;

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
  let pagesReady = false;
  const readyWaiters = [];

  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
    onPageChange?.(pdfViewer.currentPageNumber, pdfViewer.pagesCount);
    // Page heights are only meaningful once the scale above is applied, so
    // anything that measures or restores scroll offsets waits for this.
    pagesReady = true;
    for (const fn of readyWaiters.splice(0)) runWaiter(fn);
  });
  eventBus.on("pagechanging", (e) => {
    onPageChange?.(e.pageNumber, pdfViewer.pagesCount);
  });
  eventBus.on("scalechanging", (e) => onScaleChange?.(e.scale, e.presetValue));

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

  function runWaiter(fn) {
    try {
      fn();
    } catch (err) {
      console.error("[scholar-reader] pages-ready handler failed", err);
    }
  }

  // Runs fn once the first layout exists, immediately if that already happened.
  function whenReady(fn) {
    if (pagesReady) runWaiter(fn);
    else readyWaiters.push(fn);
  }

  // Takes the bytes rather than a URL: the caller has already fetched them to
  // compute the document hash, and pdf.js may detach the buffer from here on.
  async function load(bytes) {
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
  //
  // The heading is placed a little below the top rather than flush against it:
  // arriving with the heading jammed into the edge reads as a cut-off page. In
  // PDF points, so the gap keeps its proportion to the text as the zoom changes;
  // +y is up, so leaving air above the heading means scrolling to a larger y.
  // Near the top of a page that overshoots into the one before, which is what
  // `allowNegativeOffset` is for and is the right thing to show.
  function scrollToSection({ page, y, yEnd, height }) {
    if (!pdfDocument) return;
    const pageNumber = Math.min(Math.max(page ?? 1, 1), pdfViewer.pagesCount);
    pdfViewer.scrollPageIntoView({
      pageNumber,
      destArray: [null, { name: "XYZ" }, null, y === undefined || y === null ? null : y + SCROLL_TOP_MARGIN, null],
      allowNegativeOffset: true,
    });
    // Landing somewhere down a dense page is otherwise indistinguishable from
    // not having moved at all.
    flashAt(pdfViewer.getPageView(pageNumber - 1), y, yEnd, height);
  }

  // Where a {page, y} target sits in the scroll container, for scroll-spy.
  // Recomputed on demand rather than cached: zoom, a pane resize and a re-render
  // each move every one of them.
  function offsetOf({ page, y }) {
    const pageView = pdfViewer.getPageView((page ?? 1) - 1);
    if (!pageView?.div || !pageView.viewport) return null;
    const [, top] = pageView.viewport.convertToViewportPoint(0, y ?? 0);
    return pageView.div.offsetTop + top;
  }

  // scrollHeight rides along because an exact offset only means anything at the
  // layout that produced it.
  function position() {
    return {
      page: pdfViewer.currentPageNumber,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
  }

  function restorePosition(pos) {
    if (!pos || !pdfDocument) return;
    if (pos.scrollHeight && pos.scrollHeight === container.scrollHeight) {
      container.scrollTop = pos.scrollTop;
    } else if (pos.page > 1) {
      // A different window width rescales every offset; the page number is the
      // part that survives, so fall back to it rather than landing at random.
      pdfViewer.currentPageNumber = Math.min(pos.page, pdfViewer.pagesCount);
    }
  }

  function zoomBy(direction) {
    const current = pdfViewer.currentScale;
    const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
    const next = steps.find((s) => (direction > 0 ? s > current + 0.001 : s < current - 0.001));
    if (next) pdfViewer.currentScaleValue = String(next);
  }

  // A typed page or zoom, validated by toolbar-fields.js. `zoomTo` also takes a
  // pdf.js preset such as "page-width", which the resize observer then keeps.
  function goToPage(n) {
    if (pdfDocument) pdfViewer.currentPageNumber = Math.min(Math.max(n, 1), pdfViewer.pagesCount);
  }

  function zoomTo(scale) {
    if (pdfDocument) pdfViewer.currentScaleValue = String(scale);
  }

  function destroy() {
    resizeObserver.disconnect();
    pdfDocument?.destroy();
    pdfDocument = null;
  }

  return {
    load,
    whenReady,
    position,
    restorePosition,
    scrollToSection,
    offsetOf,
    zoomBy,
    zoomTo,
    goToPage,
    destroy,
    eventBus,
    get document() {
      return pdfDocument;
    },
  };
}
