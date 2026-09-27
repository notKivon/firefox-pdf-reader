// The reader's look, mirrored in the background so a capture's skeleton page can
// be drawn in the right theme and at the right pane width without waiting on
// storage inside a blocking webRequest listener. Owned by the viewer modules
// that write them; this only reads.
import { THEME_KEY } from "../viewer/theme.js";
import { DEFAULT_WIDTH, WIDTH_KEY } from "../viewer/pane-resize.js";

export function createPrefs() {
  const prefs = { theme: "dark", outlineWidth: DEFAULT_WIDTH };

  const apply = (values) => {
    if (THEME_KEY in values) prefs.theme = values[THEME_KEY] === "light" ? "light" : "dark";
    if (WIDTH_KEY in values && Number.isFinite(values[WIDTH_KEY])) prefs.outlineWidth = values[WIDTH_KEY];
  };

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const values = {};
    for (const key of [THEME_KEY, WIDTH_KEY]) if (key in changes) values[key] = changes[key].newValue;
    apply(values);
  });

  browser.storage.local
    .get([THEME_KEY, WIDTH_KEY])
    .then(apply)
    .catch((err) => {
      // Dark at the default width is what the reader shows with nothing stored.
      console.warn("[scholar-reader] could not read the reader's theme for capture pages", err);
    });

  return prefs;
}
