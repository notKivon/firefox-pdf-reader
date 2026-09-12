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
