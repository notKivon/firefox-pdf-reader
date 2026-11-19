// Sections chosen by the model, placed by this machine (2026-11-18, at the
// user's request).
//
// For a provider with `sections: "model"`, the model reads the whole paper —
// line by line, in reading order, References already cut — and decides where
// its sections begin. It does that by copying each section's opening line
// (the printed heading) word for word. Nothing it says is a position: this
// module finds each copied line among the paper's own extracted lines, in
// order, and every page and y comes from the line found. A heading that is not
// in the paper is a malformed answer, never a guess (CLAUDE.md: no position
// comes from the model).
//
// It runs twice: in the background, as the checksum before an outline may be
// cached, and in the viewer on every open, to find each section's lines for
// bullet placement — so nothing about where a section's lines are is cached.
import { normalizeText } from "./normalize.js";
import { joinLines } from "./assemble.js";

export const MAX_MODEL_SECTIONS = 40;

/** One line per row, a marker at each new page: the text a model reads. */
export function paperText(paper) {
  const out = [];
  let page = null;
  for (const line of paper) {
    if (line.page !== page) {
      page = line.page;
      out.push(`[page ${page}]`);
    }
    out.push(line.str);
  }
  return out.join("\n");
}

export const paperChars = (paper) => paper.reduce((sum, line) => sum + line.str.length + 1, 0);

// Words are what match: case, punctuation, math styling and spacing are not
// differences, so "4.2. Accuracy" and "4.2 Accuracy" are the same heading. A
// heading cut at a hyphenated line break is rejoined before comparing.
const norm = (str) =>
  normalizeText(String(str ?? ""))
    .replace(/�/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// "4 2 accuracy of …" → "accuracy of …"; "iv results" → "results"; "a key
// findings" → "key findings". The numbering is how the model and the text layer
// most often disagree, and the least informative part of a heading.
const NUMBERING = /^(?:(?:\d{1,2}|[ivxl]{1,5}|[a-h])\s+)+/;
const core = (str) => str.replace(NUMBERING, "");
const words = (str) => (str ? str.split(" ").length : 0);

function joined(paper, i, k) {
  let raw = "";
  for (let j = i; j < Math.min(paper.length, i + k); j++) {
    const str = paper[j].str;
    raw = !raw ? str : /\p{Ll}-$/u.test(raw) ? raw.slice(0, -1) + str : `${raw} ${str}`;
  }
  return norm(raw);
}

// A line that is the heading and then only a number is a table-of-contents
// entry ("4.2 Galaxy survey priors 11"; dot leaders are already gone as
// punctuation), not the heading itself. Without this, a paper with a contents
// page placed every section on it — the contents list them all, in order,
// before the first real one (a 42-page JCAP paper, 2026-11-19).
const starts = (candidate, heading) =>
  candidate === heading || (candidate.startsWith(`${heading} `) && !/^\d{1,4}$/.test(candidate.slice(heading.length + 1)));

// Three ways a printed heading meets the text layer, tried in this order over
// the whole remaining paper so the strictest match anywhere wins:
//   exact   — the line (or up to three lines, for a long title) starts with it;
//   bare    — the same once numbering is set aside on both sides, so a model
//             that writes "4.2." where the PDF has "4.2" still lands; a
//             one-word heading must then be the whole line;
//   suffix  — the heading ends a line that column-merging prefixed with stray
//             text ("…regular Cartesian subgrid within 4.2. Accuracy of the
//             voxelised density field", an A&A paper, 2026-11-19), for headings
//             of three words or more.
// → [line index, lines taken], or null.
function find(paper, from, heading) {
  const bare = core(heading);
  const tiers = [
    (i) => {
      for (let k = 1; k <= 3; k++) {
        const c = joined(paper, i, k);
        if (starts(c, heading)) return k;
        if (!heading.startsWith(c)) return 0;
      }
      return 0;
    },
    (i) => {
      if (!bare) return 0;
      for (let k = 1; k <= 3; k++) {
        const c = core(joined(paper, i, k));
        if (words(bare) >= 2 ? starts(c, bare) : c === bare) return k;
        if (!bare.startsWith(c)) return 0;
      }
      return 0;
    },
    (i) => {
      if (words(bare) < 3) return 0;
      const c = norm(paper[i].str);
      return c.endsWith(` ${heading}`) || c.endsWith(` ${bare}`) ? 1 : 0;
    },
  ];
  for (const tier of tiers) {
    for (let i = from; i < paper.length; i++) {
      const span = tier(i);
      if (span) return [i, span];
    }
  }
  return null;
}

/**
 * Places each returned heading in the paper, searching forward from the last
 * one placed, so sections keep the paper's order and a phrase is not matched
 * twice.
 *
 * A heading that cannot be found is not a guess and not the end of the outline
 * (2026-11-19, at the user's request: one stray heading used to discard the
 * whole answer). Its section is kept with its bullets, marked `unplaced`, and
 * jumps to where the section before it begins — or the top of the paper — and
 * it is never given lines of its own. The caller decides how many unplaced
 * sections make the answer unusable.
 *
 * @param {{heading: string, title?: string}[]} returned the model's sections
 * @param {{page, y, str}[]} paper
 * @returns {{sections: {title, heading, page, y, start, span, end, unplaced}[], unplaced: number, missing: string|null}}
 *   `missing` names the first heading that could not be placed, or is null.
 */
export function anchorSections(returned, paper) {
  const sections = [];
  let from = 0;
  let missing = null;
  let unplaced = 0;
  let previous = null;
  for (const section of returned ?? []) {
    const heading = norm(section?.heading);
    const hit = heading ? find(paper, from, heading) : null;
    const title = String(section?.title ?? section?.heading ?? "").trim() || String(section?.heading ?? "").trim();
    // The first section is the one the paper opens with, so when its heading
    // cannot be found — a title broken by a publisher's badge ("crossmark"
    // between its two lines, an Elsevier paper, 2026-11-19) — it starts at the
    // paper's first line. Order, not a guess; it keeps its lines and quotes.
    if (!hit && sections.length === 0 && paper.length) {
      previous = { page: paper[0].page, y: paper[0].y };
      sections.push({ title, heading: String(section?.heading ?? "").trim(), page: previous.page, y: previous.y, start: 0, span: 0, unplaced: false });
      from = 0;
      continue;
    }
    if (!hit) {
      unplaced++;
      missing ??= String(section?.heading ?? "");
      const at = previous ?? { page: paper[0]?.page ?? 1, y: paper[0]?.y ?? null };
      sections.push({ title, heading: String(section?.heading ?? "").trim(), page: at.page, y: at.y, start: -1, span: 0, unplaced: true });
      continue;
    }
    const [found, span] = hit;
    previous = { page: paper[found].page, y: paper[found].y };
    sections.push({ title, heading: String(section.heading).trim(), page: previous.page, y: previous.y, start: found, span, unplaced: false });
    from = found + span;
  }
  // A placed section runs to the next placed one; an unplaced one has no lines.
  let next = paper.length;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].unplaced) {
      sections[i].end = -1;
      continue;
    }
    sections[i].end = next;
    next = sections[i].start;
  }
  return { sections, unplaced, missing };
}

/**
 * Each placed section's own text and lines: from its heading to the next one.
 * A run-in heading keeps the text that follows it on its line.
 */
export function bodiesOf(placed, paper) {
  return placed.map((section) => {
    const base = { title: section.title, heading: section.heading, page: section.page, y: section.y, unplaced: section.unplaced === true };
    if (section.unplaced) return { ...base, text: "", lines: [] };
    const span = section.span ?? 1;
    const lines = paper.slice(section.start + span, section.end);
    const first = paper[section.start];
    // A run-in heading keeps the words after it on its line; what is left of
    // the line once the heading's own words are taken away.
    const rest = span === 1 ? remainder(first.str, section.heading) : "";
    const head = rest ? [{ ...first, str: rest }] : [];
    return { ...base, text: joinLines([...head, ...lines]), lines: [...head, ...lines] };
  });
}

function remainder(line, heading) {
  const want = norm(heading).split(" ").filter(Boolean);
  const tokens = String(line).split(/\s+/);
  let used = 0;
  let matched = 0;
  while (used < tokens.length && matched < want.length) {
    const word = norm(tokens[used]);
    used++;
    if (!word) continue;
    for (const part of word.split(" ")) if (part === want[matched]) matched++;
  }
  if (matched < want.length || !norm(line).startsWith(norm(heading))) return "";
  return tokens.slice(used).join(" ").replace(/^[\s:.]+/, "");
}
