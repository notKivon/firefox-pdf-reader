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

// Whitespace, case and math styling are not differences; words are. A heading
// cut at a hyphenated line break is rejoined, so a model that copies it whole
// still finds it.
const norm = (str) =>
  normalizeText(String(str ?? ""))
    .replace(/�/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function startsLine(candidate, heading) {
  return candidate === heading || candidate.startsWith(`${heading} `) || candidate.startsWith(`${heading}:`);
}

// A heading may wrap onto a second line; it may also be run in, with body text
// after it on the same line. → how many lines it takes, or 0 for no match.
function matchAt(paper, i, heading) {
  const one = norm(paper[i].str);
  if (startsLine(one, heading) || startsLine(one, heading.replace(/[.:]$/, ""))) return 1;
  if (i + 1 >= paper.length || !heading.startsWith(one)) return 0;
  const two = /\p{Ll}-$/u.test(one) ? one.slice(0, -1) + norm(paper[i + 1].str) : `${one} ${norm(paper[i + 1].str)}`;
  return startsLine(two, heading) ? 2 : 0;
}

/**
 * Finds each returned heading in the paper, searching forward from the last,
 * so sections stay in the paper's order and a repeated phrase is not matched
 * twice.
 *
 * @param {{heading: string, title?: string}[]} returned the model's sections
 * @param {{page, y, str}[]} paper
 * @returns {{sections: {title, heading, page, y, start, end}[], missing: string|null}}
 *   `sections` is every section placed before the first one that could not be;
 *   `missing` names that one, or is null when all were placed.
 */
export function anchorSections(returned, paper) {
  const placed = [];
  let from = 0;
  let missing = null;
  for (const section of returned ?? []) {
    const heading = norm(section?.heading);
    if (!heading) {
      missing = String(section?.heading ?? "");
      break;
    }
    let found = -1;
    let span = 1;
    for (let i = from; i < paper.length; i++) {
      span = matchAt(paper, i, heading);
      if (span) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      missing = String(section.heading);
      break;
    }
    placed.push({
      title: String(section.title ?? section.heading).trim() || String(section.heading).trim(),
      heading: String(section.heading).trim(),
      page: paper[found].page,
      y: paper[found].y,
      start: found,
      span,
    });
    from = found + span;
  }
  placed.forEach((section, i) => {
    section.end = i + 1 < placed.length ? placed[i + 1].start : paper.length;
  });
  return { sections: placed, missing };
}

/**
 * Each placed section's own text and lines: from its heading to the next one.
 * A run-in heading keeps the text that follows it on its line.
 */
export function bodiesOf(placed, paper) {
  return placed.map((section) => {
    const span = section.span ?? 1;
    const lines = paper.slice(section.start + span, section.end);
    const first = paper[section.start];
    const rest = span === 1 ? first.str.slice(Math.min(first.str.length, section.heading.length)).replace(/^[\s:.]+/, "") : "";
    const head = rest && norm(first.str).startsWith(norm(section.heading)) ? [{ ...first, str: rest }] : [];
    return {
      title: section.title,
      heading: section.heading,
      page: section.page,
      y: section.y,
      text: joinLines([...head, ...lines]),
      lines: [...head, ...lines],
    };
  });
}
