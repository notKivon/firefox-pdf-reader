// The key that identifies one outline: sha256:providerId:model:strategy:promptVersion.
//
// It is also the consent key (CLAUDE.md). Every component is there because
// changing it changes what would be sent or what comes back: a different model,
// a different chunking strategy or a bumped prompt is a different artifact and a
// different thing being sent somewhere, so it neither hits the cache nor
// inherits the grant.
import { getProvider } from "../model/providers.js";
import { PROMPT_VERSION } from "../model/prompts.js";

/**
 * @param {string} hash sha256 of the raw PDF bytes
 * @param {string} providerId
 * @returns {string}
 */
export function cacheKey(hash, providerId) {
  const { model, strategy } = getProvider(providerId);
  return `${hash}:${providerId}:${model}:${strategy}:${PROMPT_VERSION}`;
}
