// Theme is per-profile, not per document: storage.local, dark by default.
const THEME_KEY = "theme";

const SVG_NS = "http://www.w3.org/2000/svg";

// Drawn rather than typed. The toggle was `☀` (U+2600) and `☾` (U+263E) until
// the reader reported it rendering as a tofu box. The cause was not established
// — both codepoints are correct in the source and in `dist/`, and STIX Two Math
// and Apple Symbols each carry a real, non-empty outline for both — so this
// does not fix a diagnosis, it removes the dependency: an inline SVG needs no
// font, no fallback chain and no glyph coverage, and cannot tofu. Which is the
// right shape for a control whose meaning IS its symbol, whatever the cause was.
function svg(paths, { fill = false } = {}) {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", "0 0 16 16");
  root.setAttribute("width", "14");
  root.setAttribute("height", "14");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  root.setAttribute("fill", fill ? "currentColor" : "none");
  if (!fill) {
    root.setAttribute("stroke", "currentColor");
    root.setAttribute("stroke-width", "1.4");
    root.setAttribute("stroke-linecap", "round");
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    root.append(path);
  }
  return root;
}

// A sun: a disc and eight rays, stroked so it takes the button's own colour.
const sun = () =>
  svg([
    "M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z",
    "M8 .9v1.8M8 13.3v1.8M.9 8h1.8M13.3 8h1.8M2.98 2.98l1.27 1.27M11.75 11.75l1.27 1.27M13.02 2.98l-1.27 1.27M4.25 11.75l-1.27 1.27",
  ]);

// A crescent, filled: one disc with another bitten out of it.
const moon = () => svg(["M13.2 10.6A5.9 5.9 0 0 1 5.4 2.8a5.6 5.6 0 1 0 7.8 7.8Z"], { fill: true });

function apply(theme) {
  // Dark is the CSS default on :root; only light needs the attribute.
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function label(theme) {
  return theme === "light" ? "Switch to dark theme" : "Switch to light theme";
}

// The icon is decorative (aria-hidden); the button's name comes from the label,
// which is what a screen reader reads and what the tooltip shows.
function draw(button, theme) {
  button.replaceChildren(theme === "light" ? moon() : sun());
  button.title = label(theme);
  button.setAttribute("aria-label", label(theme));
}

export async function initTheme(button) {
  let theme = "dark";
  try {
    const stored = await browser.storage.local.get(THEME_KEY);
    if (stored[THEME_KEY] === "light") theme = "light";
  } catch (err) {
    // A storage failure must not leave the page unthemed; dark is the default.
    console.warn("[scholar-reader] could not read theme, using dark", err);
  }
  apply(theme);
  if (!button) return;

  draw(button, theme);
  button.addEventListener("click", async () => {
    theme = theme === "light" ? "dark" : "light";
    apply(theme);
    draw(button, theme);
    try {
      await browser.storage.local.set({ [THEME_KEY]: theme });
    } catch (err) {
      console.warn("[scholar-reader] theme not saved", err);
    }
  });
}
