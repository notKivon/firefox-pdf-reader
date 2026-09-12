// The outline itself: a TL;DR, then one block per section with its bullets.
//
// CLAUDE.md: every bullet carries the `page` and `y` of its section, so clicking
// a bullet and clicking its heading land in the same place — the bullet is a way
// into the section, not a location of its own. The title rendered is always the
// extracted one; the model's echo is a checksum and never reaches the screen.
import { el } from "./el.js";

const targetOf = (section) => ({ page: section.page, y: section.y });

function bulletList(section, onJump) {
  const list = el("ul", "outline-bullets");
  for (const bullet of section.bullets) {
    const item = el("li", "outline-bullet");
    const go = el("button", "outline-bullet-go", bullet);
    go.type = "button";
    go.addEventListener("click", () => onJump?.(targetOf(section)));
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

function sectionBlock(section, onJump, partial) {
  const block = el("section", "outline-section");
  const heading = el("button", "outline-title");
  heading.type = "button";
  heading.append(el("span", "outline-page", `p${section.page}`), el("span", "outline-title-text", section.title));
  heading.addEventListener("click", () => onJump?.(targetOf(section)));
  block.append(heading, section.bullets?.length ? bulletList(section, onJump) : emptyBody(section, partial));
  return block;
}

/**
 * @param {{sections: object[], tldr?: string}} result an outline, whole or partial
 * @param {{onJump?: (target: {page, y}) => void, partial?: boolean}} options
 * @returns {{node, targets: {page, y}[], setActive: (index: number) => void}}
 */
export function outlineList(result, { onJump, partial = false } = {}) {
  const node = el("div", "outline");

  if (result.tldr) {
    const box = el("div", "outline-tldr");
    box.append(el("h2", "outline-tldr-label", "In short"), el("p", "outline-tldr-text", result.tldr));
    node.append(box);
  }

  const blocks = result.sections.map((section) => {
    const block = sectionBlock(section, onJump, partial);
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
