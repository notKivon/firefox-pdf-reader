// One conversation per document, from the chat tab. Read and written only by
// the background page (see background/records.js for why no page touches
// IndexedDB itself).
import { CHATS, del, get, update } from "./db.js";

// Every turn is sent again with each question, so an unbounded history would
// grow every request. Past this many messages the oldest fall away.
export const MAX_MESSAGES = 60;

/** @returns {Promise<{role: string, content: string, providerId: string, model: string, at: number}[]>} */
export async function chatHistory(hash) {
  return (await get(CHATS, hash))?.messages ?? [];
}

/** Appends one question and its reply together, so a failed turn leaves nothing. */
export function appendTurn(hash, question, reply, { providerId, model }) {
  const at = Date.now();
  return update(CHATS, hash, (existing) => ({
    hash,
    messages: [
      ...(existing?.messages ?? []),
      { role: "user", content: question, providerId, model, at },
      { role: "assistant", content: reply, providerId, model, at: Date.now() },
    ].slice(-MAX_MESSAGES),
    updatedAt: at,
  }));
}

export function clearChat(hash) {
  return del(CHATS, hash);
}
