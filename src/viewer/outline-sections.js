// The sections a finished outline stands on, and the paper as it is sent.
// Split from outline-pane.js.
import { anchorSections, bodiesOf } from "../extract/anchor.js";

// The background's rule (model/model-sections.js), kept here rather than
// imported so this page does not pull the model modules in.
const MAX_UNPLACED_SHARE = 0.5;

// The whole paper, for a provider that chooses its own sections: text and the
// position each line already has on this machine, nothing else.
// The PDF's size and pages, for a plan: enough to say what would be sent, with
// none of the bytes, which travel only with an actual send.
export const pdfInfoOf = (pdf) => (pdf?.data ? { size: pdf.data.byteLength, pages: pdf.pages } : undefined);

export const paperForSending = (paper) => (paper ?? []).map(({ page, y, str }) => ({ page, y, str }));

/**
 * The finished outline's sections, each with its own text and lines. A model
 * that chose its sections named each one by its heading line, and that line is
 * found again here, in the live extraction, on every open — so nothing about
 * where a section's lines are is ever cached. Sections the router was sent come
 * with their lines already. Null when a cached outline no longer fits this
 * extraction; its bullets then jump to their section headings, as before.
 */
export function resolvedSections(result, current) {
  if (!result?.sections?.length) return null;
  if (!result.sections.some((section) => section.heading)) return current?.sections ?? null;
  const paper = current?.paper ?? [];
  const { sections, unplaced } = anchorSections(result.sections, paper);
  return unplaced > MAX_UNPLACED_SHARE * sections.length ? null : bodiesOf(sections, paper);
}
