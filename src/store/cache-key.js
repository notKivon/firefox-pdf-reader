// The key that identifies one outline: sha256:providerId:model:strategy:promptVersion.
//
// It is also the consent key (CLAUDE.md). Every component is there because
// changing it changes what would be sent or what comes back: a different model,
// a different chunking strategy or a bumped prompt is a different artifact and a
// different thing being sent somewhere, so it neither hits the cache nor
// inherits the grant.
import { getProvider } from "../model/providers.js";
import { PROMPT_VERSION } from "../model/prompts.js";
import { CHAT_PROMPT_VERSION } from "../model/chat-prompt.js";

/**
 * @param {string} hash sha256 of the raw PDF bytes
 * @param {string} providerId
 * @returns {string}
 */
export function cacheKey(hash, providerId) {
  const { model, strategy } = getProvider(providerId);
  return `${hash}:${providerId}:${model}:${strategy}:${PROMPT_VERSION}`;
}

/**
 * The chat tab's consent key: the same shape, with "chat" where the strategy
 * goes. Chatting sends the paper on every question along with the questions
 * themselves — a different thing being sent than an outline, so it has its own
 * approval, per document and per model, like an outline's.
 */
export function chatKey(hash, providerId) {
  const { model } = getProvider(providerId);
  return `${hash}:${providerId}:${model}:chat:${CHAT_PROMPT_VERSION}`;
}
