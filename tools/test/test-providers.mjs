// Test-only providers: a quota-limited pair on one destination, one
// whole-document and one per-section, with automatic fallback between them.
//
// The shipped list stopped having such a pair when Gemini 3 was removed
// (2026-11-18), but the machinery is still there — daily quotas, 429 fallback
// inside a destination, the per-section strategy over the OpenAI wire — and it
// still has to be right. These descriptors keep it exercised. They reuse the
// old ids and values so the existing assertions read the same, and they exist
// only in tests: nothing in src/ names them.
//
// Import this FIRST in a test file, before anything that reaches
// store/settings.js, which computes the default order once when it loads.
import { FALLBACK_ORDER, PROVIDERS } from "../../src/model/providers.js";

Object.assign(PROVIDERS, {
  "gemini-prod": {
    label: "Gemini 3.8 Flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyRef: "gemini",
    destination: "google",
    strategy: "whole-document",
    limits: { rpd: 10_000, rpm: 1_000, tpm: 2_000_000 },
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
    pricing: null,
    supports: { jsonSchema: true, streaming: true, reasoningOff: true },
  },
});
FALLBACK_ORDER.push("gemini-prod", "gemini-dev");
