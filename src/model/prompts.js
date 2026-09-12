// Prompt text and the JSON schemas the providers decode against.
//
// PROMPT_VERSION is part of the cache key: bump it by hand on ANY change to the
// text or the schemas below, or outlines written by the old prompt keep being
// served as current. It is also part of the consent key, so a bump correctly
// asks the reader again before the new prompt sends their paper anywhere.
export const PROMPT_VERSION = 1;

export const MAX_BULLET_WORDS = 20;

const RULES = [
  "Write 2 to 4 bullets for each section. Never fewer than 2, never more than 4.",
  `Each bullet is at most ${MAX_BULLET_WORDS} words.`,
  "Be extractive: restate what the section says. Never infer, evaluate, speculate, or add anything the text does not state.",
  "Where the section reports numbers, keep them verbatim — values, units, percentages, dataset sizes, model names.",
  "Write nothing about the reference list, acknowledgements or funding.",
  "Echo each section's title back exactly as it was given, character for character, including its numbering.",
].map((rule) => `- ${rule}`).join("\n");

const SYSTEM = `You summarise sections of an academic paper for a researcher skimming it.

${RULES}

Answer with JSON only, matching the supplied schema.`;

const TLDR_RULE = "Also write a TL;DR for the whole paper: at most 2 sentences, extractive, no hedging.";

const plural = (n) => `${n} ${n === 1 ? "section" : "sections"}`;

function sectionBlock(section, index) {
  return `### Section ${index + 1}\nTitle: ${section.title}\n\n${section.text}`;
}

/** One request carrying the whole paper. Used by `whole-document` providers. */
export function wholeDocumentMessages(sections, meta = {}) {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  const body = sections.map(sectionBlock).join("\n\n");
  return [
    { role: "system", content: `${SYSTEM}\n\n${TLDR_RULE}` },
    {
      role: "user",
      content:
        `${header}Summarise each of the ${plural(sections.length)} below, in the order given, ` +
        `returning exactly ${plural(sections.length)}.\n\n${body}`,
    },
  ];
}

/** One section per request. Used by `per-section` providers. */
export function sectionMessages(section, meta = {}) {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${header}Summarise this one section.\n\n${sectionBlock(section, 0)}` },
  ];
}

/**
 * The reduce step for `per-section`: a TL;DR written from the bullets, since no
 * single request in that strategy ever saw the whole paper.
 */
export function tldrMessages(sections, meta = {}) {
  const header = meta.title ? `Paper: ${meta.title}\n\n` : "";
  const digest = sections
    .map((section) => `${section.title}\n${section.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");
  return [
    { role: "system", content: `${SYSTEM}\n\n${TLDR_RULE}` },
    {
      role: "user",
      content: `${header}These are the section summaries of one paper. ${TLDR_RULE}\n\n${digest}`,
    },
  ];
}

// Structured output is constrained decoding, so anything the schema can express
// is enforced rather than asked for. minItems/maxItems pin both the section
// count and the bullet count — but see PROGRESS.md: whether Gemini's
// OpenAI-compatibility layer honours those two keywords is verified by a real
// call, and the adapter's own checks stand regardless of the answer.
const bulletsSchema = {
  type: "array",
  minItems: 2,
  maxItems: 4,
  items: { type: "string" },
};

/**
 * @param {number} sectionCount sections sent, pinned as both min and max
 * @param {{tldr?: boolean}} [options] `per-section` requests carry no TL;DR
 */
export function outlineSchema(sectionCount, { tldr = true } = {}) {
  const properties = {
    sections: {
      type: "array",
      minItems: sectionCount,
      maxItems: sectionCount,
      items: {
        type: "object",
        properties: { title: { type: "string" }, bullets: bulletsSchema },
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
