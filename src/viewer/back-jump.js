// "Back to where you were" after a jump (2026-11-19, at the user's request).
//
// Every jump from the outline, the chat or the Extraction panel first asks this
// to remember the reading spot; a button over the paper then returns there.
// A run of jumps keeps the spot from before the FIRST of them — the reader was
// reading there, not at the second bullet they clicked. The spot is stored as a
// share of the scroll height, so zooming in between does not send Back to the
// wrong page (reading-position.js stores it the same way, for the same reason).

/**
 * @param {object} args
 * @param {HTMLElement} args.container the scrolling PDF pane
 * @param {HTMLButtonElement} args.button shown while there is a spot to go back to
 */
export function createBackJump({ container, button }) {
  let spot = null;

  const show = (on) => {
    button.hidden = !on;
  };

  function remember() {
    if (spot) return;
    const height = container.scrollHeight || 1;
    spot = { top: container.scrollTop / height, left: container.scrollLeft };
    show(true);
  }

  function back() {
    if (!spot) return;
    container.scrollTop = spot.top * (container.scrollHeight || 1);
    container.scrollLeft = spot.left;
    spot = null;
    show(false);
  }

  /** Forget the spot without moving — the reader settled where they jumped. */
  function dismiss() {
    spot = null;
    show(false);
  }

  button.addEventListener("click", back);
  // Alt+← goes back too, as it does in the browser itself; Escape dismisses.
  window.addEventListener("keydown", (event) => {
    if (!spot) return;
    if (event.key === "ArrowLeft" && event.altKey) {
      event.preventDefault();
      back();
    } else if (event.key === "Escape") {
      dismiss();
    }
  });

  show(false);
  return { remember, back, dismiss, get pending() { return spot !== null; } };
}
