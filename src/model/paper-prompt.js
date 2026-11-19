// The prompt for a provider that chooses its own sections (`sections: "model"`
// in providers.js): the whole paper in, its sections and their bullets out.
//
// The paper goes as extracted lines in reading order, with a marker at each new
// page and the References already cut. The model names where each section
// begins by copying that line; extract/anchor.js finds it. Line numbers are
// deliberately NOT given: a number is an offset, and asking a model for an
// offset is forbidden (CLAUDE.md). A copied line can only be checked against
// the text, and a wrong one fails rather than lands somewhere plausible.
//
// Part of PROMPT_VERSION in prompts.js: bump that on any change here.
import { MAX_MODEL_SECTIONS, paperText } from "../extract/anchor.js";
import { pdfPart } from "./pdf.js";

const STYLE = {
  guidelines: `Use your judgement on how many bullets each section deserves and how long they are: a short section may need one, a dense one several. Aim for something scannable. Stay faithful to what the paper says rather than evaluating it, and keep the figures a results section reports. Also write a brief TL;DR of the whole paper.`,
  strict: `Write 2 to 4 bullets per section, each at most 20 words. Be extractive: restate what the section says, never add to it. Keep reported numbers verbatim. Also write a TL;DR of at most 2 sentences.`,
};

const SOURCE = {
  text: `The paper below is its extracted text, one line per row, in reading order, with "[page N]" where each page begins. Extraction is imperfect: figure and table captions, running headers, page numbers, footnotes and stray chart labels are mixed in.`,
  pdf: `The paper is attached as a PDF. Read it as printed — equations, superscripts, tables and figures included. Leave out the reference list, running headers and footers.`,
};

const INSTRUCTIONS = (style, source = "text") => `You are outlining an academic paper for a researcher who wants to skim it and jump to what matters.

${SOURCE[source]}

First, find the paper's own sections as its author laid them out: the numbered or lettered headings (for example "I. INTRODUCTION", "A. Key Findings", "3.2 Training"), plus the title-and-abstract block before the first heading. Numbered list items, figure and table captions, and lines that merely look like headings are not sections. Keep subsections as their own sections where they have substantial text; merge them into their parent when the paper has more than ${MAX_MODEL_SECTIONS}.

For each section, in order:
- "heading": the section's printed heading, copied exactly as it appears, number included (for example "4.2. Accuracy of the voxelised density field"); for the title-and-abstract block, the paper's title. Copy it; do not correct, renumber or shorten it.
- "title": a clean name for the section to display, for example "I. Introduction" or "Title and abstract".
- "bullets": what the section says.

${STYLE[style === "guidelines" ? "guidelines" : "strict"]}

Write nothing about the reference list, acknowledgements or funding. Answer with JSON only, matching the supplied schema.`;

/**
 * @param {{page, y, str}[]} paper extract/sections.js's `paper`
 * @param {{title?: string}} meta
 * @param {string} style the provider's promptStyle
 */
export function paperMessages(paper, meta = {}, style = "strict", pdf = null) {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  if (pdf?.data) {
    return [
      { role: "system", content: INSTRUCTIONS(style, "pdf") },
      { role: "user", content: [pdfPart(pdf.data), { type: "text", text: `${header}Outline the attached paper.` }] },
    ];
  }
  return [
    { role: "system", content: INSTRUCTIONS(style) },
    { role: "user", content: `${header}${paperText(paper)}` },
  ];
}

export function paperSchema(style = "strict") {
  const bullets =
    style === "guidelines"
      ? { type: "array", minItems: 1, items: { type: "string" } }
      : { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } };
  return {
    type: "object",
    properties: {
      sections: {
        type: "array",
        minItems: 1,
        maxItems: MAX_MODEL_SECTIONS,
        items: {
          type: "object",
          properties: { heading: { type: "string" }, title: { type: "string" }, bullets },
          required: ["heading", "title", "bullets"],
          additionalProperties: false,
        },
      },
      tldr: { type: "string" },
    },
    required: ["sections", "tldr"],
    additionalProperties: false,
  };
}
