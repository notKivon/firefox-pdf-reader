// Equations in model output, typeset with KaTeX (2026-11-19, at the user's
// request). The models are asked to write math as LaTeX — $…$ inline, $$…$$
// on its own — and this finds those spans and renders them; everything else
// stays text.
//
// Model output is never markup. KaTeX builds its own nodes from the TeX, with
// `trust: false` so no \href, \url or \htmlClass reaches the page, and a span
// KaTeX cannot parse is shown as the text the model wrote rather than as an
// error box or nothing.
import katex from "katex";

const OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: "ignore",
  output: "htmlAndMathml",
  maxSize: 20,
  maxExpand: 500,
};

// Delimiters in the order they are tried at each position. `$…$` follows the
// usual Markdown rule so prices are not math: no space just inside either
// dollar, and no digit straight after the closing one ("costs $5 and $10").
const PATTERNS = [
  { re: /\$\$([^]+?)\$\$/y, display: true },
  { re: /\\\[([^]+?)\\\]/y, display: true },
  { re: /\\\(([^]+?)\\\)/y, display: false },
  { re: /\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/y, display: false },
];

/**
 * @param {string} text
 * @returns {({text: string} | {tex: string, display: boolean, source: string})[]}
 */
export function mathParts(text) {
  const parts = [];
  let plain = "";
  let i = 0;
  const str = String(text ?? "");
  while (i < str.length) {
    const ch = str[i];
    let hit = null;
    if (ch === "$" || ch === "\\") {
      if (ch === "\\" && str[i + 1] === "$") {
        plain += "$";
        i += 2;
        continue;
      }
      for (const { re, display } of PATTERNS) {
        re.lastIndex = i;
        const m = re.exec(str);
        if (m && m[1].trim()) {
          hit = { tex: m[1].trim(), display, source: m[0] };
          break;
        }
      }
    }
    if (hit) {
      if (plain) parts.push({ text: plain });
      plain = "";
      parts.push(hit);
      i += hit.source.length;
    } else {
      plain += ch;
      i += 1;
    }
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

/** One typeset span, or the model's own text when KaTeX cannot read it. */
export function mathNode({ tex, display, source }) {
  const node = document.createElement(display ? "div" : "span");
  node.className = display ? "math math-display" : "math";
  try {
    katex.render(tex, node, { ...OPTIONS, displayMode: display });
  } catch {
    node.className = "math math-raw";
    node.textContent = source;
  }
  return node;
}

/**
 * Text with its math typeset, as nodes to append.
 * @param {string} text
 * @param {(text: string) => Node} [textNode] how plain runs are made
 */
export function withMath(text, textNode = (t) => document.createTextNode(t)) {
  return mathParts(text).map((part) => (part.tex === undefined ? textNode(part.text) : mathNode(part)));
}

// A model that writes `\beta` or `\frac` inside a JSON string without escaping
// the backslash leaves a backspace or form feed where the "\b"/"\f" was (seen
// with a local model, normalize.js). Before a letter those can only have been
// TeX, so they are turned back into it; so is a tab before a letter (\theta,
// \times, \tau). Newlines and carriage returns are left alone — real ones are
// far more common than \nu or \rho written unescaped.
export function repairTex(str) {
  return String(str ?? "").replace(/[\b\f\t](?=[A-Za-z])/g, (c) => ({ "\b": "\\b", "\f": "\\f", "\t": "\\t" })[c]);
}
