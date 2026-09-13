// The outline itself: a TL;DR, then one block per section with its bullets.
//
// CLAUDE.md: every bullet carries the `page` and `y` of its section, so clicking
// a bullet and clicking its heading land in the same place — the bullet is a way
// into the section, not a location of its own. The title rendered is always the
// extracted one; the model's echo is a checksum and never reaches the screen.
import { el } from "./el.js";
import { normalizeModelText, normalizeText } from "../extract/normalize.js";
import { locateBullet } from "./locate.js";

const targetOf = (section) => ({ page: section.page, y: section.y });

// Is the reader part-way through selecting text inside this element? A drag
// that ends inside a jump target still fires a click, and jumping the paper out
// from under a half-made selection is the reported bug in its other direction.
function selectingInside(node) {
  const selection = node.ownerDocument?.defaultView?.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  return node.contains?.(selection.anchorNode) || node.contains?.(selection.focusNode);
}

/**
 * Makes an ordinary element behave as a jump control.
 *
 * These were `<button>`s until the reader reported they could not select or
 * copy a summary — button label text is not selectable, which is the whole
 * point of a button and exactly wrong for a pane whose content is prose worth
 * quoting. The affordance is kept by hand: a role and a tab stop for assistive
 * technology and the keyboard, Enter and Space to activate, and text that
 * selects like text because it is text.
 */
function jumpable(node, target, onJump) {
  node.tabIndex = 0;
  node.setAttribute?.("role", "button");
  node.addEventListener("click", () => {
    if (!selectingInside(node)) onJump?.(target);
  });
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onJump?.(target);
  });
  return node;
}

function bulletList(section, onJump, lines) {
  const list = el("ul", "outline-bullets");
  for (const bullet of section.bullets) {
    const item = el("li", "outline-bullet");
    // Normalised here as well as at extraction: this text is the model's, and a
    // model both echoes the paper's notation and writes LaTeX of its own.
    const go = el("div", "outline-bullet-go", normalizeModelText(bullet));
    // A bullet goes to the lines it restates when those can be found in the
    // paper, and to its heading when they cannot. The location is computed
    // here from the section's own text — never supplied by the model. See
    // locate.js for why that distinction is the whole point.
    const located = lines ? locateBullet(bullet, lines) : null;
    if (located) go.classList.add("is-located");
    jumpable(go, located ?? targetOf(section), onJump);
    item.append(go);
    list.append(item);
  }
  return list;
}

// A section that failed and a section that had nothing to say must never render
// the same way (PROGRESS.md, 2026-09-12): one is a fault, one is the paper's own
// structure, and a third — still being written — is neither.
function emptyBody(section, partial) {
  if (section.error) return el("p", "outline-section-error", section.error);
  if (partial) return el("p", "outline-section-pending", "Writing…");
  return el("p", "outline-section-empty", "No text of its own — the next heading follows immediately.");
}

function sectionBlock(section, onJump, partial, lines) {
  const block = el("section", "outline-section");
  const heading = el("div", "outline-title");
  heading.append(
    el("span", "outline-page", `p${section.page}`),
    // The extracted title, never the model's echo — that is only a checksum.
    el("span", "outline-title-text", normalizeText(section.title)),
  );
  jumpable(heading, targetOf(section), onJump);
  block.append(heading, section.bullets?.length ? bulletList(section, onJump, lines) : emptyBody(section, partial));
  return block;
}

/**
 * @param {{sections: object[], tldr?: string}} result an outline, whole or partial
 * @param {object} options
 * @param {(target: {page, y}) => void} [options.onJump]
 * @param {boolean} [options.partial]
 * @param {(index: number) => object[]|undefined} [options.linesFor] the
 *   extracted body lines of the section at that index, for locating bullets.
 *   Absent during progressive fill: under `per-section` the sections that have
 *   landed are compacted, so an index there is not an index into the paper, and
 *   a target derived from the wrong section is worse than the heading.
 * @returns {{node, targets: {page, y}[], setActive: (index: number) => void}}
 */
export function outlineList(result, { onJump, partial = false, linesFor } = {}) {
  const node = el("div", "outline");

  if (result.tldr) {
    const box = el("div", "outline-tldr");
    box.append(el("h2", "outline-tldr-label", "In short"), el("p", "outline-tldr-text", normalizeModelText(result.tldr)));
    node.append(box);
  }

  const blocks = result.sections.map((section, index) => {
    const block = sectionBlock(section, onJump, partial, linesFor?.(index));
    node.append(block);
    return block;
  });

  let active = -1;

  // Driven by the scroll-spy. -1 is a real value: above the first heading no
  // section is the current one, and marking one anyway would be a lie.
  function setActive(index) {
    if (index === active) return;
    blocks[active]?.classList.remove("is-current");
    active = index;
    const block = blocks[index];
    if (!block) return;
    block.classList.add("is-current");
    // The pane scrolls independently of the paper, so the current section can
    // easily be off-screen. `nearest` moves it only when it actually is.
    block.scrollIntoView?.({ block: "nearest" });
  }

  return { node, targets: result.sections.map(targetOf), setActive };
}
