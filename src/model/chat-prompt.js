// The chat tab's prompt: the paper as the system prompt, the conversation as
// the turns. Kept apart from prompts.js because it is a different artifact with
// its own version, which is part of the chat consent key (store/cache-key.js).
//
// CHAT_PROMPT_VERSION: bump on any change to the text below, so a reader who
// approved one prompt is asked again before a different one sends their paper.
export const CHAT_PROMPT_VERSION = 1;

// How the model names a section it relied on. The viewer turns a citation into
// a jump link only when the title matches a section extracted on this machine,
// and the target comes from that section — never from the model (CLAUDE.md:
// no position ever comes from the model).
export const CITATION = /\[§\s*([^\]\n]{1,200}?)\s*\]/g;

const INSTRUCTIONS = `You are helping a researcher read the academic paper below. Answer their questions about it.

Use your judgement on length: a direct question deserves a direct answer. Ground what you say in the paper and say plainly when it does not cover something; if you bring in outside knowledge, mark it as such.

When you rely on a particular section, cite it inline as [§ Title], using that section's title exactly as it appears after "Title:" below — for example [§ 3 Method]. The reader's screen turns those into links to the section.

Write plain text: short paragraphs, and "- " for a list when one helps. No headings, tables or other markdown.`;

/**
 * @param {{title: string, text: string}[]} sections the extraction, References
 *   already cut off — the same text an outline sends
 * @param {{title?: string}} meta
 * @param {{role: "user"|"assistant", content: string}[]} history earlier turns
 * @param {string} question
 */
export function chatMessages(sections, meta, history, question) {
  const body = sections
    .filter((section) => section.text.trim())
    .map((section) => `Title: ${section.title}\n\n${section.text}`)
    .join("\n\n---\n\n");
  const header = meta?.title ? `Paper: ${meta.title}\n\n` : "";
  return [
    { role: "system", content: `${INSTRUCTIONS}\n\n=== THE PAPER ===\n\n${header}${body}` },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: question },
  ];
}

/**
 * Splits a reply into text and citations. A citation is kept as a link only when
 * its title matches an extracted section; anything else stays as the words the
 * model wrote, so a slip shows as text rather than as a link to nowhere.
 *
 * @param {string} text
 * @param {{title: string}[]} sections
 * @returns {({text: string} | {cite: string, index: number})[]}
 */
export function splitCitations(text, sections) {
  const byTitle = new Map();
  sections.forEach((section, index) => {
    const key = normal(section.title);
    if (key && !byTitle.has(key)) byTitle.set(key, index);
  });
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const index = byTitle.get(normal(match[1]));
    if (index === undefined) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ cite: sections[index].title, index });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

const normal = (title) => String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
