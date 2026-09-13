// The page number and zoom level in the toolbar, as fields the reader can type
// into. Each shows the live value while unfocused and takes a new one on Enter
// (or on leaving the field with a changed value); Escape puts the live value back.

// Wider than the zoom buttons reach on purpose, and short of pdf.js's own 25×,
// where a single page's canvas becomes expensive enough to stall the tab.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// "12" → 12, clamped into the document. Anything that is not a whole number is
// refused rather than guessed at, and the field goes back to the live page.
export function parsePage(text, total) {
  const match = /^\s*(\d+)\s*$/.exec(text ?? "");
  if (!match || !total) return null;
  return Math.min(Math.max(Number(match[1]), 1), total);
}

// "150", "150%" and "150 %" all mean 1.5×. A percentage is what the field shows,
// so it is what the reader types back.
export function parseZoom(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text ?? "");
  if (!match) return null;
  const scale = Number(match[1]) / 100;
  if (!(scale > 0)) return null;
  return Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
}

export const formatZoom = (scale) => `${Math.round(scale * 100)}%`;

// Wires one field. `commit(text)` returns whether the value was usable; either
// way the field is redrawn from the live value, so a refused entry, or one that
// changed nothing, never lingers looking as though it took effect.
function bindField(input, { display, commit }) {
  const redraw = () => {
    input.value = display();
  };
  input.addEventListener("focus", () => input.select());
  input.addEventListener("change", () => {
    commit(input.value);
    redraw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(input.value);
      redraw();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      redraw();
      input.blur();
    }
  });
  // Live updates skip a focused field: scrolling while typing must not replace
  // what the reader is halfway through entering.
  return () => {
    if (document.activeElement !== input) redraw();
  };
}

export function createToolbarFields({ pageInput, pageTotal, zoomInput, view }) {
  let page = 0;
  let total = 0;
  let scale = 0;

  const refreshPage = bindField(pageInput, {
    display: () => (total ? String(page) : "–"),
    commit: (text) => {
      const target = parsePage(text, total);
      if (target !== null) view.goToPage(target);
    },
  });
  const refreshZoom = bindField(zoomInput, {
    display: () => (scale ? formatZoom(scale) : "–"),
    commit: (text) => {
      const target = parseZoom(text);
      if (target !== null) view.zoomTo(target);
    },
  });

  return {
    setPage(nextPage, nextTotal) {
      page = nextPage;
      total = nextTotal;
      pageTotal.textContent = `/ ${nextTotal}`;
      pageInput.max = String(nextTotal);
      refreshPage();
    },
    setScale(nextScale) {
      scale = nextScale;
      refreshZoom();
    },
  };
}
