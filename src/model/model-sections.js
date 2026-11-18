// The outline run for a provider that chooses its own sections: one request
// carrying the whole paper, its answer placed on the paper by extract/anchor.js.
//
// The checksum is the placement itself. Every heading the model names must be
// found, in order, among the paper's own lines, or the answer is malformed and
// nothing is cached — the same rule the title echo enforces for providers that
// are sent the sections (align.js), for the same reason: a cached outline is
// served with no network request ever after.
import { MAX_MODEL_SECTIONS, anchorSections } from "../extract/anchor.js";
import { ProviderError } from "./errors.js";
import { paperMessages, paperSchema } from "./paper-prompt.js";

const clean = (bullets) =>
  Array.isArray(bullets) ? bullets.filter((b) => typeof b === "string").map((b) => b.trim()).filter(Boolean) : [];

// Sections as the rest of the app knows them: a title, a jump target from the
// paper, the bullets — and the heading the model copied, so the viewer can find
// the section's lines again on every open without anything being stored.
const finished = (placed, returned) =>
  placed.map((section, i) => ({
    title: section.title,
    heading: section.heading,
    page: section.page,
    y: section.y,
    bullets: clean(returned[i]?.bullets),
  }));

/**
 * @param {object} args
 * @param {string} args.id provider id, for errors
 * @param {object} args.provider descriptor
 * @param {{page, y, str}[]} args.paper
 * @param {object} args.meta
 * @param {(messages, schema, onPartial) => Promise<object>} args.call
 * @param {(partial: {sections: object[]}) => void} [args.onProgress]
 */
export async function paperOutline({ id, provider, paper, meta, call, onProgress }) {
  const style = provider.promptStyle;
  // Progressive fill: every streamed section that can already be placed is
  // shown. One that cannot yet be placed stops the fill there until the whole
  // answer is in and checked below.
  const onPartial = onProgress
    ? (partials) => {
        const { sections } = anchorSections(partials, paper);
        if (sections.length) onProgress({ sections: finished(sections, partials) });
      }
    : undefined;

  const data = await call(paperMessages(paper, meta, style), paperSchema(style), onPartial);
  const returned = Array.isArray(data?.sections) ? data.sections : null;
  if (!returned?.length) {
    throw new ProviderError("The model's response had no sections.", { kind: "malformed", providerId: id });
  }
  if (returned.length > MAX_MODEL_SECTIONS) {
    throw new ProviderError(`The model returned ${returned.length} sections; the most an outline holds is ${MAX_MODEL_SECTIONS}.`, {
      kind: "malformed",
      providerId: id,
    });
  }
  const { sections, missing } = anchorSections(returned, paper);
  if (missing !== null) {
    throw new ProviderError(
      `The model named a section heading, "${missing.slice(0, 120)}", that is not in the paper ` +
        "(or not after the one before it). Bullets could not be placed, so nothing was saved.",
      { kind: "malformed", providerId: id },
    );
  }
  return { sections: finished(sections, returned), tldr: typeof data.tldr === "string" ? data.tldr : "", modelSections: true };
}
