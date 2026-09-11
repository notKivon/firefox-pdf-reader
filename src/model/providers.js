// Provider descriptors. Public constants only.
//
// SECRETS: no API keys live here or anywhere else in the repo. `keyRef` names
// the slot in `browser.storage.local` that the settings page writes the key
// into; the background router reads it at call time. See CLAUDE.md.
//
// Rate limits below are the real Tier 1 (paid) numbers read off the user's AI
// Studio rate-limit page on 2026-09-11, not the free-tier placeholders that
// SPEC.md was drafted against.

export const PROVIDERS = {
  "gemini-prod": {
    label: "Gemini 3.8 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyRef: "gemini",
    strategy: "whole-document",
    limits: { rpd: 10_000, rpm: 1_000, tpm: 2_000_000 },
    params: { reasoning_effort: "low" },
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  },
  "gemini-dev": {
    label: "Gemini 3.5 Flash-Lite (development)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.5-flash-lite",
    keyRef: "gemini",
    strategy: "per-section",
    limits: { rpd: 150_000, rpm: 4_000, tpm: 4_000_000 },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
  ollama: {
    label: "Gemma 4 E4B (local)",
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "gemma4:e4b",
    keyRef: null,
    strategy: "per-section",
    limits: null,
    params: { options: { num_ctx: 32768 } },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
};

// The user's stated preference: 3.8 Flash serves reading by default. Quality on
// the paper they actually read outweighs the token cost, which at a few papers
// a day is under a dollar a year.
export const DEFAULT_PROVIDER_ID = "gemini-prod";

// Tried in order when a provider is quota-exhausted or answers 429. Ollama is
// last because it is only reachable when the local server happens to be up.
export const FALLBACK_ORDER = ["gemini-prod", "gemini-dev", "ollama"];

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
