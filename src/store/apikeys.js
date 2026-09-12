// Provider API keys: entered by the user in settings, stored in
// `browser.storage.local`, read only in the background page.
//
// SECRETS (CLAUDE.md): no key is ever in the repo or the built bundle, and none
// is ever handed to the viewer context — the background router is the only
// place a provider is called, so it is the only place a key is needed.
export const API_KEYS_STORAGE_KEY = "apiKeys";

/**
 * @param {string} keyRef the descriptor's `keyRef`, e.g. "gemini"
 * @returns {Promise<string|null>} null when nothing is stored yet
 */
export async function getApiKey(keyRef) {
  if (!keyRef) return null;
  const stored = await browser.storage.local.get(API_KEYS_STORAGE_KEY);
  const key = stored?.[API_KEYS_STORAGE_KEY]?.[keyRef];
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/** @param {string} keyRef @param {string} value */
export async function setApiKey(keyRef, value) {
  const stored = await browser.storage.local.get(API_KEYS_STORAGE_KEY);
  const keys = { ...(stored?.[API_KEYS_STORAGE_KEY] ?? {}) };
  if (value.trim()) keys[keyRef] = value.trim();
  else delete keys[keyRef];
  await browser.storage.local.set({ [API_KEYS_STORAGE_KEY]: keys });
}

/** Which providers have a key on hand, for the settings page and the plan. */
export async function hasApiKey(keyRef) {
  return (await getApiKey(keyRef)) !== null;
}
