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

/** @param {string} str @returns {string} */
export function normalizeText(str) {
  if (!str) return str;
  // `replace` with a global regex starts at 0 and resets `lastIndex`, so this is
  // safe to call repeatedly — a `test()` guard in front of it would not be.
  return str.replace(RESTYLED, (ch) => ch.normalize("NFKC"));
}
