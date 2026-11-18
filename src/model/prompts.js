// Prompt text and the JSON schemas the providers decode against.
//
// PROMPT_VERSION is part of the cache key: bump it by hand on ANY change to the
// text or the schemas below, or outlines written by the old prompt keep being
// served as current. It is also part of the consent key, so a bump correctly
// asks the reader again before the new prompt sends their paper anywhere.
// 2 (2026-11-18): extraction reads columns properly and keeps the front matter,
// and the Claude and Gemini providers now choose their own sections
// (paper-prompt.js). Outlines built on the old sections are not served.
export const PROMPT_VERSION = 2;

export const MAX_BULLET_WORDS = 20;

const RULES = [
  "Write 2 to 4 bullets for each section. Never fewer than 2, never more than 4.",
  `Each bullet is at most ${MAX_BULLET_WORDS} words. This is a hard limit: count the words, and drop detail rather than exceed it. A bullet of ${MAX_BULLET_WORDS + 1} words is wrong.`,
  "Be extractive: restate what the section says. Never infer, evaluate, speculate, or add anything the text does not state.",
  "Where the section reports numbers, keep them verbatim — values, units, percentages, dataset sizes, model names.",
  "If the section reports results or measurements, at least one bullet must carry the specific figures it reports, not a description of them.",
  "Write nothing about the reference list, acknowledgements or funding.",
  "Echo the value of each section's Title field back exactly as given, character for character, including its numbering. Never answer with any other text as the title.",
].map((rule) => `- ${rule}`).join("\n");

const STRICT = `You summarise sections of an academic paper for a researcher skimming it.

${RULES}

Answer with JSON only, matching the supplied schema.`;

// For models that do not need the limits spelled out (promptStyle
// "guidelines" in providers.js — Opus and Sonnet). Changed 2026-11-18 at the
// user's request: judgement over hard counts. Two lines stay firm because they
// are correctness, not style — the echoed title is the alignment checksum, and
// the answer is decoded against the schema. Editing this text means bumping
// PROMPT_VERSION, the same as the strict text.
const GUIDELINES = `You are writing a section-by-section outline of an academic paper for a researcher who wants to skim it and jump to what matters.

Use your judgement on how many bullets each section deserves and how long they are: a short section may need one, a dense one several. Aim for something scannable. Stay faithful to what the paper says rather than evaluating it, keep the figures a results section reports, and leave out the reference list, acknowledgements and funding.

Two things are fixed: echo each section's Title field back exactly as given, character for character, and answer with JSON only, matching the supplied schema.`;

const system = (style) => (style === "guidelines" ? GUIDELINES : STRICT);

const TLDR_RULES = {
  strict: "Also write a TL;DR for the whole paper: at most 2 sentences, extractive, no hedging.",
  guidelines: "Also write a brief TL;DR of the whole paper.",
};
const tldrRule = (style) => TLDR_RULES[style === "guidelines" ? "guidelines" : "strict"];

const plural = (n) => `${n} ${n === 1 ? "section" : "sections"}`;

// The section's own title must be the only thing in the block that looks like a
// title. An earlier version opened each block with "### Section N", and a
// per-section request echoed back "### Section 1" as the title — caught by the
// adapter's checksum, but it cost that section its bullets. Under
// whole-document the ordinal has to be there for the model to keep its place,
// so it is carried as a labelled field rather than as a heading.
function sectionBlock(section, index, { ordinal = true } = {}) {
  const head = ordinal ? `[Section ${index + 1} of the paper]\n` : "";
  return `${head}Title: ${section.title}\n\nText:\n${section.text}`;
}

/** One request carrying the whole paper. Used by `whole-document` providers. */
export function wholeDocumentMessages(sections, meta = {}, style = "strict") {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  const body = sections.map(sectionBlock).join("\n\n");
  return [
    { role: "system", content: `${system(style)}\n\n${tldrRule(style)}` },
    {
      role: "user",
      content:
        `${header}Summarise each of the ${plural(sections.length)} below, in the order given, ` +
        `returning exactly ${plural(sections.length)}.\n\n${body}`,
    },
  ];
}

/** One section per request. Used by `per-section` providers. */
export function sectionMessages(section, meta = {}, style = "strict") {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  return [
    { role: "system", content: system(style) },
    {
      role: "user",
      content:
        `${header}Summarise this one section. Echo its title back exactly as ` +
        `"${section.title}".\n\n${sectionBlock(section, 0, { ordinal: false })}`,
    },
  ];
}

/**
 * The reduce step for `per-section`: a TL;DR written from the bullets, since no
 * single request in that strategy ever saw the whole paper.
 */
export function tldrMessages(sections, meta = {}, style = "strict") {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  const digest = sections
    .map((section) => `${section.title}\n${section.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");
  return [
    { role: "system", content: `${system(style)}\n\n${tldrRule(style)}` },
    {
      role: "user",
      content: `${header}These are the section summaries of one paper. ${tldrRule(style)}\n\n${digest}`,
    },
  ];
}

// Structured output is constrained decoding, so anything the schema can express
// is enforced rather than asked for. minItems/maxItems pin both the section
// count and the bullet count — but see PROGRESS.md: whether Gemini's
// OpenAI-compatibility layer honours those two keywords is verified by a real
// call, and the adapter's own checks stand regardless of the answer.
const bulletsSchema = (style) =>
  style === "guidelines"
    ? { type: "array", minItems: 1, items: { type: "string" } }
    : { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } };

/**
 * @param {number} sectionCount sections sent, pinned as both min and max
 * @param {{tldr?: boolean, style?: string}} [options] `per-section` requests
 *   carry no TL;DR; `style` is the provider's promptStyle
 */
export function outlineSchema(sectionCount, { tldr = true, style = "strict" } = {}) {
  const properties = {
    sections: {
      type: "array",
      minItems: sectionCount,
      maxItems: sectionCount,
      items: {
        type: "object",
        properties: { title: { type: "string" }, bullets: bulletsSchema(style) },
        required: ["title", "bullets"],
        additionalProperties: false,
      },
    },
  };
  if (tldr) properties.tldr = { type: "string" };
  return {
    type: "object",
    properties,
    required: tldr ? ["sections", "tldr"] : ["sections"],
    additionalProperties: false,
  };
}

export const tldrSchema = {
  type: "object",
  properties: { tldr: { type: "string" } },
  required: ["tldr"],
  additionalProperties: false,
};
