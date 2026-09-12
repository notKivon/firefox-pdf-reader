// Size and cost estimates for the confirm card. Nothing here feeds quota
// arithmetic — see the warning on estimateTokens.
import { getProvider } from "./providers.js";

// Characters per token, the usual rule of thumb for English prose. A real
// tokeniser is not worth bundling for a number shown to one reader, which is
// why every figure derived from it is labelled "est." and why quota counting
// (step 10) counts requests and the provider's own reported usage instead.
const CHARS_PER_TOKEN = 4;

// The prompt and the model's own output are not in `chars`; both matter to a
// cost estimate. Measured over the fixtures the prompt is ~350 tokens and the
// bullets come back at roughly a tenth of the input.
const PROMPT_TOKENS = 350;
const OUTPUT_RATIO = 0.1;

export const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

export function totalChars(sections) {
  return sections.reduce((sum, section) => sum + section.text.length + section.title.length, 0);
}

/**
 * Estimated US dollars for one document, or null when the descriptor carries no
 * pricing — the card omits the line rather than guessing.
 *
 * @param {string} providerId
 * @param {number} inTokens estimated input tokens
 * @param {number} [requests] prompt repetitions: 1 whole-document, N per-section
 */
export function estimateCost(providerId, inTokens, requests = 1) {
  const { pricing } = getProvider(providerId);
  if (!pricing) return null;
  const promptTokens = PROMPT_TOKENS * requests;
  const outTokens = Math.ceil(inTokens * OUTPUT_RATIO);
  const dollars =
    ((inTokens + promptTokens) * pricing.inPerM + outTokens * pricing.outPerM) / 1_000_000;
  return dollars;
}
