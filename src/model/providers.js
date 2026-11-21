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
  // Claude through the local bridge (tools/claude-bridge.mjs), which runs Claude
  // Code headless on the reader's own subscription login — never an Anthropic
  // API key. `keyRef` here is the bridge's own token, not a provider key.
  // `pricing: null` because a subscription has no per-token price to state.
  // `promptStyle: "guidelines"` asks for judgement rather than hard limits; see
  // prompts.js. Haiku keeps the strict rules the small models need.
  "claude-opus": claudeVia("Claude Opus 5.5", "claude-opus-5-5", "guidelines"),
  "claude-sonnet": claudeVia("Claude Sonnet 5.5", "claude-sonnet-5-5", "guidelines"),
  "claude-haiku": claudeVia("Claude Haiku 5.5", "claude-haiku-5-5", "strict"),
  // Gemini 4, added 2026-11-18 at the user's request. The three ids are the ones
  // the user's key lists at /v1beta/openai/models; Google's model card says
  // nothing about which is the larger, so they keep Google's own names. A tiny
  // structured-output call to each streamed and decoded cleanly the same day.
  // They replaced Gemini 3.8 Flash and 3.5 Flash-Lite, removed at the user's
  // request the same day. Not in FALLBACK_ORDER: chosen explicitly. Limits and
  // pricing are not filled in — not read off the console yet, and a guess on the
  // confirm card would be worse than no line.
  "gemini-4-argon": gemini4("Gemini 4 Argon", "gemini-4-argon"),
  "gemini-4-carbon": gemini4("Gemini 4 Carbon", "gemini-4-carbon"),
  "gemini-4-hydrogen": gemini4("Gemini 4 Hydrogen", "gemini-4-hydrogen"),
  // Added 2026-11-21 at the user's request, the same way: listed for their key,
  // and a streamed structured-output call with the PDF attached read it right.
  "gemini-4-neon": gemini4("Gemini 4 Neon", "gemini-4-neon"),
  ollama: {
    label: "Gemma 4 E4B (local)",
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "gemma4:e4b",
    keyRef: null,
    destination: "local",
    strategy: "per-section",
    limits: null,
    pricing: null,
    // Spoken to over Ollama's own /api/chat rather than its OpenAI-compatible
    // layer, which silently drops `options` — so `num_ctx` never arrived and
    // the model loaded at 4096, truncating long sections without a word. See
    // model/ollama-native.js for the measurement.
    useNativeEndpoint: true,
    // `think: false` because the bullets are the answer and the thinking is
    // not: gemma4 spent 631 eval tokens against 199 with it off, for the same
    // output, and a local model's latency is the reader's wait.
    params: { options: { num_ctx: 32768 }, think: false },
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
};

function gemini4(label, model) {
  return {
    label,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model,
    keyRef: "gemini",
    destination: "google",
    strategy: "whole-document",
    limits: null,
    pricing: null,
    promptStyle: "guidelines",
    sections: "model",
    // Sent the PDF itself (model/pdf.js); ~12k tokens for a 7-page paper.
    pdf: true,
    pdfTokensPerPage: 1_700,
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  };
}

function claudeVia(label, model, promptStyle) {
  return {
    label: `${label} (via Claude Code)`,
    baseUrl: "http://127.0.0.1:8765/v1/",
    model,
    keyRef: "claude-bridge",
    destination: "anthropic",
    strategy: "whole-document",
    limits: null,
    pricing: null,
    bridge: true,
    promptStyle,
    // The model reads the whole paper and chooses its sections; this machine
    // places them (model/model-sections.js, extract/anchor.js).
    sections: "model",
    // Sent the PDF itself, as a document block via the bridge (model/pdf.js);
    // ~24k tokens for a 7-page paper.
    pdf: true,
    pdfTokensPerPage: 3_400,
    supports: { jsonSchema: true, streaming: true, reasoningOff: false },
  };
}

// The user's stated preference (2026-11-18): Opus 5.5 on their Claude Code
// subscription serves reading by default. Gemini stays available as an explicit
// choice; it was the default from step 1 until then.
export const DEFAULT_PROVIDER_ID = "claude-opus";

// Tried in order when a provider is quota-exhausted or answers 429.
//
// `ollama` is deliberately NOT in this list. The user's rule: Gemini by
// default, the local model only when they say so. Automatic fallback therefore
// stays inside one `destination` — same text, same company, so the consent
// already given still covers it — and reaching the local model is an explicit
// act, offered as a control when the Google chain runs out.
//
// Only the ids listed here are ever reached automatically, whatever the reader's
// order says (`fallbacksFor`). Since 2026-11-18 that is Opus alone, so nothing
// is: Sonnet, Haiku and every Gemini model are the reader's choice, made in
// settings or from the pane, never a quiet consequence of a usage limit.
export const FALLBACK_ORDER = ["claude-opus"];

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
 * The order is the reader's own from settings when the router has one. Whatever
 * it holds, the destination filter is what keeps the local model out of every
 * automatic path — no ordering can move it into a Google provider's chain.
 *
 * @param {string} id key into PROVIDERS
 * @param {string[]} [order] the configured order; FALLBACK_ORDER when absent
 * @returns {string[]} provider ids to try, in order, after `id` fails
 */
export function fallbacksFor(id, order = FALLBACK_ORDER) {
  const { destination } = getProvider(id);
  const from = order.indexOf(id);
  const rest = (from === -1 ? order : order.slice(from + 1)).filter((other) => FALLBACK_ORDER.includes(other));
  return rest.filter((other) => other !== id && getProvider(other).destination === destination);
}
