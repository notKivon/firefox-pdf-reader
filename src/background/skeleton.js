// The page a tab shows while the background captures its PDF.
//
// Capturing means the tab cannot move to the reader until the download ends —
// navigating would cancel the very response being captured. So the response's
// own body is replaced with a still picture of the reader: the same toolbar,
// panes and "Loading…" status, in the reader's theme and at its pane width, so
// the swap to the real viewer lands on a page that already looks like it.
//
// It is written into the publisher's origin, so it carries **no script**, and
// capture.js sends it under a CSP that forbids any. Progress is shown by
// appending `<style>` rules as bytes arrive: a later rule wins the cascade, so
// the bar moves with nothing executing. Every function here returns a string
// and touches no browser API, so all of it is testable in Node.
import { MIN_OUTLINE, MIN_PDF } from "../viewer/pane-resize.js";

// Copied from theme.css, which is the source of truth; tools/test/capture.test.mjs
// fails if these drift from it.
export const TOKENS = {
  dark: { bg: "#16181d", bgRaised: "#1d2026", bgSunken: "#0f1115", border: "#2b2f38", text: "#e6e8ee", textDim: "#98a0b0", accent: "#7aa2f7" },
  light: { bg: "#f4f5f7", bgRaised: "#ffffff", bgSunken: "#e7e9ee", border: "#d3d7e0", text: "#1b1e24", textDim: "#5c6472", accent: "#2f5fd0" },
};

const MB = 1024 * 1024;

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function megabytes(bytes) {
  return (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0);
}

/** What the counter under the bar says. Plain ASCII: it lands in a CSS string. */
export function countLabel(received, total) {
  return total ? `${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`;
}

/**
 * The opening of the page: everything but the progress rules.
 * @param {{name: string, theme?: string, outlineWidth?: number, total?: number|null}} opts
 */
export function skeletonHead({ name, theme = "dark", outlineWidth = 360, total = null }) {
  const t = TOKENS[theme === "light" ? "light" : "dark"];
  const safeName = escapeHtml(name);
  const width = Math.round(Number(outlineWidth) || 360);
  // Unknown length (chunked transfer) gets a moving stripe instead of a fill.
  const bar = total
    ? "#bar i{width:0}"
    : "#bar i{width:30%;animation:slide 1.2s ease-in-out infinite alternate}@keyframes slide{from{margin-left:0}to{margin-left:70%}}";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${safeName} — Scholar Reader</title>
<style>
:root{color-scheme:${theme === "light" ? "light" : "dark"}}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:${t.bg};color:${t.text};font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
#toolbar{display:flex;align-items:center;height:40px;flex:0 0 40px;padding:0 12px;background:${t.bgRaised};border-bottom:1px solid ${t.border}}
#title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#panes{display:flex;flex:1 1 auto;min-height:0}
#pdf{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;background:${t.bgSunken};color:${t.textDim}}
#pdf b{color:${t.text};font-size:15px;font-weight:600}
#pdf span{max-width:46ch;word-break:break-word}
#bar{width:220px;height:3px;border-radius:2px;background:${t.border};overflow:hidden;margin-top:4px}
#bar i{display:block;height:100%;background:${t.accent}}
#n::after{content:""}
#outline{flex:0 0 max(${MIN_OUTLINE}px,min(${width}px,calc(100vw - ${MIN_PDF}px)));background:${t.bg};border-left:1px solid ${t.border}}
${bar}
</style></head>
<body>
<header id="toolbar"><span id="title">${safeName}</span></header>
<div id="panes"><main id="pdf"><b>Loading…</b><span>${safeName}</span><div id="bar"><i></i></div><small id="n"></small></main><aside id="outline"></aside></div>
`;
}

/**
 * Hands out progress rules as bytes arrive, at most one per whole percent (or
 * per 256 KB when the length is unknown), so a large PDF writes a hundred small
 * rules rather than one per network chunk.
 * @param {number|null} total the response's Content-Length, when it sent one
 */
export function createProgress(total) {
  const step = 256 * 1024;
  let last = -1;
  return {
    /** @returns {string|null} a rule to append, or null when nothing changed enough */
    update(received) {
      const mark = total ? Math.min(100, Math.floor((received / total) * 100)) : Math.floor(received / step);
      if (mark === last) return null;
      last = mark;
      const fill = total ? `#bar i{width:${mark}%}` : "";
      return `<style>${fill}#n::after{content:"${countLabel(received, total)}"}</style>\n`;
    },
  };
}

/** The last thing written before the tab moves to the reader. */
export function openingRule() {
  return `<style>#bar i{width:100%;animation:none;margin-left:0}#n::after{content:"Opening…"}</style>\n`;
}
