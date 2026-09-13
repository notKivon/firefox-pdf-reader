// Finding the lines of the paper that a bullet is a restatement of.
//
// WHY THIS IS COMPUTED AND NOT ASKED FOR. CLAUDE.md's rule is that a bullet's
// `page`/`y` come from the extracted section at that index and NEVER from the
// model, because a misaligned bullet scrolls to the wrong place with nothing on
// screen to say so — and a cached outline is served thereafter with no request
// and no confirmation, so the slip would be permanent. Asking a model for a
// line number would be exactly the thing that rule forbids.
//
// So the location is derived here, in the viewer, from the paper's own text:
// bullets are required to be extractive, so the words of a bullet are largely
// the words of some span of its section. Matching them is arithmetic over text
// that is already on this machine. Three properties follow, and they are what
// make this safe where a model's answer would not be:
//
//   1. The search is bounded to the section the bullet belongs to, so a bad
//      match is off by lines, never by chapters — the old behaviour's target is
//      inside the search space, not outside it.
//   2. It is recomputed from the live extraction every time the document opens,
//      so nothing is cached and a cached outline needs no migration.
//   3. A weak match returns null and the caller falls back to the heading, which
//      is what every bullet did before. Not finding it is a supported answer.

// Words that say nothing about *where* in a section a sentence is: ordinary
// function words, plus the vocabulary a summary is written in. "The section
// reports that…" is the model's framing, not the paper's words, and counting it
// either way — as a match or as a miss — is noise.
const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have in into is it its of on or that the their " +
    "there these they this to was were which with we our us can may than then them such also each other " +
    "paper section authors author propose proposes proposed introduce introduces introduced present " +
    "presents presented describe describes described report reports reported show shows shown discuss " +
    "discusses state states note notes find finds found use uses used using").split(" "),
);

const WINDOW_LINES = 4;
// Below this share of a bullet's distinctive words, the match is not worth
// acting on and the heading is the honest target.
const MIN_SCORE = 0.42;
// A bullet has to put more than one distinctive word on the page before a
// position is claimed for it. One shared word is a coincidence, and at ≤20 words
// a bullet that really restates a passage shares many.
const MIN_MATCHED = 2;

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    // Keep digits and decimal points together: "28.4" is one token and is the
    // most distinctive thing a results bullet carries.
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * How much each token is worth. A word that appears on half the lines of a
 * section cannot say which line is meant; one that appears on a single line
 * nails it. This is why a bullet and a paraphrase of it usually still land in
 * the right place: the rare words survive rewording, the common ones do not
 * matter either way.
 */
function weights(lineTokens) {
  const seen = new Map();
  for (const line of lineTokens) {
    for (const token of new Set(line)) seen.set(token, (seen.get(token) ?? 0) + 1);
  }
  return (token) => {
    const frequency = seen.get(token);
    // A word the section does not contain at all still counts — against the
    // match. Scoring only over the words that happen to be present is what made
    // the first version place three foreign bullets in four: a sentence about
    // dietary sodium shares one incidental word with a section on optimisers,
    // and one word out of one word is a perfect score. Weighted below a rare
    // word that IS present, because a real bullet always carries some phrasing
    // of the model's own.
    if (!frequency) return ABSENT_WEIGHT;
    // 1 for a token on one line, falling away as it spreads across the section.
    return 1 / (1 + Math.log2(frequency));
  };
}

const ABSENT_WEIGHT = 0.55;

/**
 * The span of `lines` that best restates `bullet`.
 *
 * @param {string} bullet the model's sentence
 * @param {{page: number, y: number, height: number, str: string}[]} lines the
 *   section's own body lines, in reading order
 * @returns {{page, y, yEnd, height}|null} null when nothing matches well enough
 */
export function locateBullet(bullet, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const wanted = tokens(bullet);
  if (wanted.length === 0) return null;

  const lineTokens = lines.map((line) => tokens(line.str));
  const weightOf = weights(lineTokens);
  // Every distinct word the bullet claims, present or not — see weights().
  const distinctive = [...new Set(wanted)];
  const total = distinctive.reduce((sum, token) => sum + weightOf(token), 0);
  if (total === 0) return null;

  let best = null;
  for (let start = 0; start < lines.length; start++) {
    const covered = new Set();
    for (let span = 1; span <= WINDOW_LINES && start + span <= lines.length; span++) {
      for (const token of lineTokens[start + span - 1]) covered.add(token);
      let score = 0;
      let matched = 0;
      for (const token of distinctive) {
        if (!covered.has(token)) continue;
        score += weightOf(token);
        matched++;
      }
      // Per matched token, so a four-line window is not preferred merely for
      // being wider than a one-line window that says the same thing.
      const normalised = score / total / (1 + (span - 1) * 0.12);
      if (matched >= MIN_MATCHED && (!best || normalised > best.score)) {
        best = { score: normalised, start, end: start + span - 1 };
      }
    }
  }

  if (!best || best.score < MIN_SCORE) return null;

  // A span that crosses a page break is reported on the page it starts on:
  // the scroll lands there, and highlighting the rest would need a second band
  // on a page the reader is not looking at.
  const first = lines[best.start];
  let last = lines[best.end];
  if (last.page !== first.page) {
    let i = best.start;
    while (i + 1 <= best.end && lines[i + 1].page === first.page) i++;
    last = lines[i];
  }
  return { page: first.page, y: first.y, yEnd: last.y, height: first.height };
}
