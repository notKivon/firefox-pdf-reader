// Theme is per-profile, not per document: storage.local, dark by default.
const THEME_KEY = "theme";

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

  button.textContent = theme === "light" ? "☾" : "☀";
  button.title = label(theme);
  button.addEventListener("click", async () => {
    theme = theme === "light" ? "dark" : "light";
    apply(theme);
    button.textContent = theme === "light" ? "☾" : "☀";
    button.title = label(theme);
    try {
      await browser.storage.local.set({ [THEME_KEY]: theme });
    } catch (err) {
      console.warn("[scholar-reader] theme not saved", err);
    }
  });
}
