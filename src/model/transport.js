// Which wire a provider is spoken to over. The adapter calls `chatJson` and
// never learns the answer — the same reason it never learns a provider's
// chunking strategy (CLAUDE.md): both are properties of the provider.
//
// Two transports exist because one provider genuinely needs its own. See
// `ollama-native.js` for what the OpenAI-compatible layer drops on the floor.
import { chatJson as openaiCompat } from "./openai-compat.js";
import { chatJson as ollamaNative } from "./ollama-native.js";

/** @param {{provider: object}} args the rest is passed straight through */
export function chatJson(args) {
  return args.provider.useNativeEndpoint ? ollamaNative(args) : openaiCompat(args);
}
