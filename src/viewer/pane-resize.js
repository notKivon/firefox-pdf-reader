// Dragging the edge between the paper and the outline pane. The width is
// per-profile, like the theme: storage.local, not per document.
const WIDTH_KEY = "outlineWidth";

export const DEFAULT_WIDTH = 360;
export const MIN_OUTLINE = 240;
// The paper keeps at least this much; it is what the reader came for.
export const MIN_PDF = 320;

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

// The outline pane's width for a requested one, inside a window this wide. On a
// window too narrow for both minimums the outline's wins, because below it the
// bullets wrap a word per line and stop being readable at all.
export function clampWidth(width, windowWidth) {
  const max = windowWidth - MIN_PDF;
  return Math.round(Math.max(MIN_OUTLINE, Math.min(width, max)));
}

export async function initPaneResize({ handle, pane }) {
  // What the reader asked for, kept apart from what the window allows: shrinking
  // the window and growing it back returns the pane to the width they chose.
  let wanted = DEFAULT_WIDTH;
  try {
    const stored = await browser.storage.local.get(WIDTH_KEY);
    if (Number.isFinite(stored[WIDTH_KEY])) wanted = stored[WIDTH_KEY];
  } catch (err) {
    console.warn("[scholar-reader] could not read the outline width, using the default", err);
  }

  const apply = () => {
    const width = clampWidth(wanted, window.innerWidth);
    document.documentElement.style.setProperty("--outline-width", `${width}px`);
    handle.setAttribute("aria-valuenow", String(width));
    return width;
  };

  const save = () => {
    browser.storage.local.set({ [WIDTH_KEY]: wanted }).catch((err) => {
      console.warn("[scholar-reader] outline width not saved", err);
    });
  };

  // Stored as the clamped width, so a drag past the limit does not leave a
  // phantom width that the next larger window would suddenly jump to.
  const setWanted = (width) => {
    wanted = width;
    wanted = apply();
  };

  apply();
  handle.setAttribute("aria-valuemin", String(MIN_OUTLINE));
  window.addEventListener("resize", apply);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    // The pane's right edge is fixed during a drag, so the width is the distance
    // from the pointer to it.
    const right = pane.getBoundingClientRect().right;
    document.body.classList.add("is-resizing");

    const move = (e) => setWanted(right - e.clientX);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-resizing");
      save();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });

  // The handle sits to the pane's left, so the arrow moves the edge the way it
  // points: left widens the outline, right narrows it.
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    if (event.key === "ArrowLeft") setWanted(wanted + step);
    else if (event.key === "ArrowRight") setWanted(wanted - step);
    else if (event.key === "Home") setWanted(DEFAULT_WIDTH);
    else return;
    event.preventDefault();
    save();
  });

  handle.addEventListener("dblclick", () => {
    setWanted(DEFAULT_WIDTH);
    save();
  });
}
