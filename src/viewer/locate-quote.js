// Placing a bullet by a quote it carries (2026-11-19). Split from locate.js,
// whose word match is still the fallback.
import { spanTarget } from "./locate.js";

// A model that read the rendered PDF paraphrases further from the text layer
// than one that read the text layer, so the word match above lands less often.
// It is therefore also asked for a short QUOTE per bullet — words copied from
// the paper, the same kind of answer as a copied heading (extract/anchor.js):
// text that either is in the section or is not. Never a position.

const QUOTE_MIN_WORDS = 4;
// Share of the quote's words that must appear, in order, in one stretch: the
// rendered PDF and its text layer disagree on ligatures, hyphens and symbols,
// so exact equality is not required — but a stretch that carries most of a
// fifteen-word quote in order is not a coincidence.
const QUOTE_MIN_SHARE = 0.8;
const QUOTE_MIN_RUN = 10;
const QUOTE_MIN_PART = 0.6;

// Greek letters by name, on both sides: a model that read "θ1" in the PDF may
// write "theta1" (an Elsevier paper, 2026-11-19), and the text layer has θ.
const GREEK = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta",
  θ: "theta", ϑ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi",
  ρ: "rho", σ: "sigma", ς: "sigma", τ: "tau", υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
};

const plainWords = (str) =>
  String(str ?? "")
    .normalize("NFKC") // ﬁ, ﬀ and other ligature glyphs to their letters
    .toLowerCase()
    .replace(/[α-ωϵϑϕς]/g, (c) => GREEK[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);

// The section's words in reading order, each knowing its line. A word split by
// a hyphen at a line break ("repre-" / "sentation") is rejoined, so a quote
// that copies it whole still matches.
function wordStream(lines) {
  const stream = [];
  lines.forEach((line, index) => {
    const words = plainWords(line.str);
    const prev = stream[stream.length - 1];
    if (prev?.hyphen && words.length) {
      prev.word += words.shift();
      prev.hyphen = false;
    }
    words.forEach((word) => stream.push({ word, line: index, hyphen: false }));
    if (stream.length && /\p{Ll}-$/u.test(line.str.trim())) stream[stream.length - 1].hyphen = true;
  });
  return stream;
}

// Longest run of `quote` matched in order inside stream[from, from + width).
function inOrder(stream, from, width, quote) {
  let q = 0;
  let firstHit = -1;
  let lastHit = -1;
  const end = Math.min(stream.length, from + width);
  for (let i = from; i < end && q < quote.length; i++) {
    // A word the text layer broke at a ligature comes out as two pieces, even
    // on two lines ("signi" / "ficant"); two adjacent pieces that make the
    // quoted word count as it.
    const joined = i + 1 < end && stream[i].word + stream[i + 1].word === quote[q];
    if (stream[i].word === quote[q] || joined) {
      if (firstHit < 0) firstHit = i;
      if (joined) i++;
      lastHit = i;
      q++;
    }
  }
  return { matched: q, firstHit, lastHit };
}

/**
 * The lines a quoted passage sits on, within one section.
 * @param {string} quote words the model copied from the paper
 * @param {{page, y, height, str, x?, right?}[]} lines the section's own lines
 * @returns {{page, y, yEnd, height, x?, xEnd?}|null}
 */
export function locateQuote(quote, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const want = plainWords(quote);
  if (want.length < QUOTE_MIN_WORDS) return null;
  const stream = wordStream(lines);
  // Up to twice the quote's length: stray words can sit inside a quoted passage —
  // a table caption between columns, a keywords sidebar beside an abstract
  // (an Elsevier paper, 2026-11-19). The 80% in-order rule and the tightest
  // stretch still decide.
  const slack = want.length;
  let best = null;
  for (let from = 0; from < stream.length; from++) {
    if (stream[from].word !== want[0] && stream[from].word !== want[1]) continue;
    const hit = inOrder(stream, from, want.length + slack, want);
    // Most words matched wins; among equals, the tightest stretch — a quote
    // that opens with "the" must not be anchored on an earlier, stray "the".
    const tighter = best && hit.matched === best.matched && hit.lastHit - hit.firstHit < best.lastHit - best.firstHit;
    if (hit.matched > (best?.matched ?? 0) || tighter) best = hit;
  }
  // Most of the quote in order — or, when a table or figure interrupts the
  // quoted sentence (Table 1 mid-paragraph on an Elsevier page, 2026-11-19), a
  // long enough stretch of it: ten words in order, from the quote's start, are
  // not a coincidence.
  const enough = best && (best.matched >= QUOTE_MIN_SHARE * want.length || (best.matched >= QUOTE_MIN_RUN && best.matched >= QUOTE_MIN_PART * want.length));
  if (!enough) return null;
  return spanTarget(lines, stream[best.firstHit].line, stream[best.lastHit].line);
}
