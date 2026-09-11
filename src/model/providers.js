// Provider descriptors. Public constants only.
//
// SECRETS: no API keys live here or anywhere else in the repo. `keyRef` names
// the slot in `browser.storage.local` that the settings page writes the key
// into; the background router reads it at call time. See CLAUDE.md.
//
// Rate limits below are the real Tier 1 (paid) numbers read off the user's AI
// Studio rate-limit page on 2026-09-11, not the free-tier placeholders that
// SPEC.md was drafted against.
//
// `destination` names the party a document's text actually reaches. Send consent
// and automatic fallback are both scoped by it, so a provider swap that stays
// within one destination is covered by the consent already given and one that
// crosses destinations is not. See CLAUDE.md, "Send confirmation".
//
// `pricing` is per million tokens and exists only so the confirm card can state
// an estimated cost. Nothing else reads it.

export const PROVIDERS = {
  "gemini-prod": {
    label: "Gemini 3.8 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyRef: "gemini",
    destination: "google",
    strategy: "whole-document",
    limits: { rpd: 10_000, rpm: 1_000, tpm: 2_000_000 },
    // Promotional pricing; doubles to 1.50 / 7.50 on 2027-01-01.
    pricing: { inPerM: 0.75, outPerM: 3.75 },
    params: { reasoning_effort: "low" },
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  },
  "gemini-dev": {
    label: "Gemini 3.5 Flash-Lite (development)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.5-flash-lite",
    keyRef: "gemini",
    destination: "google",
    strategy: "per-section",
    limits: { rpd: 150_000, rpm: 4_000, tpm: 4_000_000 },
    // Not filled in: the user's per-token price for flash-lite has not been
    // read off the console, and a guessed number on the confirm card would be
    // worse than none. The card omits the cost line when pricing is null.
    pricing: null,
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
  ollama: {
    label: "Gemma 4 E4B (local)",
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "gemma4:e4b",
    keyRef: null,
    destination: "local",
    strategy: "per-section",
    limits: null,
    pricing: null,
    params: { options: { num_ctx: 32768 } },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
};

// The user's stated preference: 3.8 Flash serves reading by default. Quality on
// the paper they actually read outweighs the token cost, which at a few papers
// a day is under a dollar a year.
export const DEFAULT_PROVIDER_ID = "gemini-prod";

// Tried in order when a provider is quota-exhausted or answers 429.
//
// `ollama` is deliberately NOT in this list. The user's rule: Gemini by
// default, the local model only when they say so. Automatic fallback therefore
// stays inside one `destination` — same text, same company, so the consent
// already given still covers it — and reaching the local model is an explicit
// act, offered as a control when the Google chain runs out.
export const FALLBACK_ORDER = ["gemini-prod", "gemini-dev"];

/**
 * @param {string} id key into PROVIDERS
 * @returns {object} the descriptor
 * @throws {Error} on an unknown id, so a typo in settings surfaces as a named
 *   failure rather than a downstream `undefined` property read.
 */
export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`[scholar-reader] unknown provider "${id}"`);
  }
  return provider;
}

/**
 * The automatic fallback chain for a provider: the configured order, filtered
 * to that provider's own `destination` and starting after it. Crossing to
 * another destination is never automatic — it needs its own send confirmation,
 * so the adapter stops rather than continuing past the end of this list.
 *
 * @param {string} id key into PROVIDERS
 * @returns {string[]} provider ids to try, in order, after `id` fails
 */
export function fallbacksFor(id) {
  const { destination } = getProvider(id);
  const from = FALLBACK_ORDER.indexOf(id);
  const rest = from === -1 ? FALLBACK_ORDER : FALLBACK_ORDER.slice(from + 1);
  return rest.filter((other) => getProvider(other).destination === destination);
}
