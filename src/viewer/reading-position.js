// Restoring and saving where the reader left off. Its own module because the
// viewer entry point is at the 200-line limit, and this is one responsibility:
// the reading position, and nothing about the outline or the document record.
import { saveReadingPosition } from "../store/docs.js";

const SAVE_DEBOUNCE_MS = 600;

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

// Restores where the reader left off, then keeps the record up to date.
export function trackReadingPosition({ view, hash, container, position, onNote }) {
  const save = debounce(() => {
    saveReadingPosition(hash, view.position()).catch((err) => {
      console.warn("[scholar-reader] reading position not saved", err);
      onNote?.(`Reading position is not being saved: ${err.message}`);
    });
  }, SAVE_DEBOUNCE_MS);

  view.whenReady(() => {
    view.restorePosition(position);
    // Attached only after the restore, so the pristine top-of-document position
    // never overwrites the saved one.
    container.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", () => save.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") save.flush();
    });
  });
}
