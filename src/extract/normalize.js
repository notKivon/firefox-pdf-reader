// Making extracted text renderable in a UI font.
//
// pdf.js maps a paper's math-italic glyphs into Mathematical Alphanumeric
// Symbols (U+1D400–U+1D7FF), a plane-1 block no UI font on macOS covers — so the
// pane draws last-resort boxes with the codepoint in hex. Each character in the
// block is a *styling* of a plain letter and its NFKC form is that letter:
// `𝑎` → `a`, `𝜈` → `ν`, `𝟕` → `7`. Every font has those, and in a two-line
// summary the italic carried no information anyway.
//
// Deliberately NOT a blanket NFKC over the whole string. That would also flatten
// superscript digits (`10⁻⁸` → `10-8`), fractions and much else — and CLAUDE.md
// requires results bullets to carry the reported numbers, which is exactly the
// text that would be damaged.
//
// Used on the way in (every extracted run) and on the way out (model bullets),
// so a model that echoes the paper's notation gets the same treatment.
//
// U+210E is included because it is a hole in that block: the math italic
// alphabet has no `h` of its own and Unicode points it at PLANCK CONSTANT.
// Nothing else from Letterlike Symbols belongs here — ℝ and ℕ are the reals and
// the naturals, not styled Rs and Ns, and flattening them would lose meaning.
const RESTYLED = /[\u{1D400}-\u{1D7FF}\u{210E}]/gu;

// Adobe's Symbol-font Private Use assignments: the pieces a PDF stacks to draw
// a bracket taller than one line. They are glyph fragments rather than
// characters, so no font on any platform renders them and every one of them
// arrives as a box — confirmed in the fixtures, where a two-line square bracket
// comes through as U+F8EE on one line and U+F8F0 on the next. Each piece
// becomes the delimiter it is part of, which puts one bracket on each line the
// real one spans.
//
// Only the unambiguous parens, brackets and braces are mapped. Other private
// use characters are left exactly as they are and reported by the extraction
// panel instead: they mean a font whose glyphs could not be mapped at all, and
// guessing at those would invent text the paper does not contain.
const DELIMITER_PIECES = new Map([
  ["\uF8EB", "("], ["\uF8EC", "("], ["\uF8ED", "("],
  ["\uF8F6", ")"], ["\uF8F7", ")"], ["\uF8F8", ")"],
  ["\uF8EE", "["], ["\uF8EF", "["], ["\uF8F0", "["],
  ["\uF8F9", "]"], ["\uF8FA", "]"], ["\uF8FB", "]"],
  ["\uF8F1", "{"], ["\uF8F2", "{"], ["\uF8F3", "{"], ["\uF8F4", "{"],
  ["\uF8FC", "}"], ["\uF8FD", "}"], ["\uF8FE", "}"],
]);

const DELIMITERS = /[\uF8EB-\uF8F4\uF8F6-\uF8FE]/g;

/** Private use characters nothing can render — what the panel reports. */
export const UNRENDERABLE = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFD}]/gu;

/** @param {string} str @returns {string} */
export function normalizeText(str) {
  if (!str) return str;
  // `replace` with a global regex starts at 0 and resets `lastIndex`, so this is
  // safe to call repeatedly — a `test()` guard in front of it would not be.
  return str
    .replace(RESTYLED, (ch) => ch.normalize("NFKC"))
    .replace(DELIMITERS, (ch) => DELIMITER_PIECES.get(ch) ?? ch);
}

// A model writes LaTeX even when the paper's text layer contains none. Reported
// live: a Gemma bullet carried `$\mathbf{z}$` where it meant `z`. None of the
// eleven fixtures has a single `$…$` or `\mathbf` in its extracted text, so this
// is the model's own notation and not something coming out of a PDF — which is
// why it is stripped here, on the way out, and `normalizeText` is left alone.
// Extraction staying byte-identical is load-bearing: heading detection, section
// text, the cache key and the model payload all read it (PROGRESS.md).
//
// Conservative on purpose. Only the wrappers whose meaning is "this is maths"
// or "set this in bold" are removed, and always by keeping what they contain —
// nothing is dropped, invented or reordered. Anything unrecognised is left
// exactly as the model wrote it, because a bullet that reads oddly is better
// than one that quietly says something else.
const MATH_COMMAND = /\\(?:math(?:bf|rm|it|cal|sf|tt|bb|frak)|text(?:bf|it|rm)?|bm|boldsymbol|operatorname|mbox)\s*\{([^{}]*)\}/g;
const INLINE_MATH = /\$([^$\n]{1,200})\$|\\\(([^\n]{1,200}?)\\\)/g;

/**
 * `normalizeText`, plus the LaTeX a model adds of its own accord.
 * @param {string} str @returns {string}
 */
export function normalizeModelText(str) {
  if (!str) return str;
  // A LaTeX command whose name starts with b, f, n, r or t collides with a JSON
  // string escape: a model writing `\beta` emits `"\beta"`, which parses to a
  // BACKSPACE followed by "eta". Seen in a live Ollama run. The control
  // character is invisible but real, and it travels into the pane and into
  // anything the reader copies out of it.
  let out = normalizeText(str).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // Repeated because the wrappers nest: `$\mathbf{z}$` needs both passes, and
  // `\text{\bf x}` needs two of the inner one. Bounded so a pathological
  // string cannot spin here.
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    out = out.replace(MATH_COMMAND, "$1").replace(INLINE_MATH, (_, a, b) => a ?? b);
    if (out === before) break;
  }
  return out;
}
