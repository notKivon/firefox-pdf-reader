// The chat tab's handlers. Like outlines, every chat call starts here and only
// here, and the send-confirmation gate is this module's own read of the store:
// a page that forgets to ask cannot cause a send (CLAUDE.md).
//
// Chat runs on every provider spoken to over the OpenAI-compatible wire: the
// Claude ones through the bridge, and Gemini. Ollama's native transport has no
// text mode, so the local model stays outline-only.
//
// Consent (changed 2026-11-18 at the user's request): pressing Send in the chat
// tab is the approval. The tab states where questions go before the first one,
// the page records the grant as Send is pressed, and this gate still refuses a
// send with no grant on record — so a page that skips that step sends nothing.
import { chatMessages } from "../model/chat-prompt.js";
import { ProviderError } from "../model/errors.js";
import { estimateTokens, totalChars } from "../model/estimate.js";
import { chatText } from "../model/openai-compat.js";
import { getProvider, PROVIDERS } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { chatKey } from "../store/cache-key.js";
import { appendTurn, chatHistory, clearChat } from "../store/chats.js";
import { isConsented } from "../store/consent.js";
import { hasRoomFor, record } from "../store/quota.js";
import { providerOrder } from "./plan.js";
import { createWatchdog } from "./watchdog.js";

const PROGRESS_MESSAGE = "chat-progress";
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_QUESTION = 8_000;

export const canChat = (provider) => !provider.useNativeEndpoint;
const chatProviders = (order) => order.filter((id) => PROVIDERS[id] && canChat(PROVIDERS[id]));

/** What a chat turn would send and where, for the pane's card. No network. */
export async function chatPlan({ hash, sections, meta = {}, providerId }) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new Error("not a document hash.");
  const order = chatProviders(await providerOrder());
  const id = providerId ?? order[0];
  const provider = getProvider(id);
  if (!canChat(provider)) throw new Error(`${provider.label} does not chat; pick a Claude or Gemini model.`);
  const sendable = (sections ?? []).filter((section) => section.text?.trim());
  const key = chatKey(hash, id);
  return {
    cacheKey: key,
    kind: "chat",
    hash,
    title: meta.title ?? "",
    pageCount: meta.pageCount ?? 0,
    providerId: id,
    label: provider.label,
    model: provider.model,
    destination: provider.destination,
    bridge: provider.bridge === true,
    sectionCount: sendable.length,
    estTokens: estimateTokens(totalChars(sendable)),
    hasKey: Boolean(await getApiKey(provider.keyRef).catch(() => null)),
    consented: await isConsented(key),
    providers: order.map((other) => ({ id: other, label: PROVIDERS[other].label })),
  };
}

/**
 * One question and its streamed reply.
 *
 * @param {{hash, sections, meta, providerId, question}} request
 * @param {number|undefined} tabId where the reply streams to
 * @param {{watchdog?: object}} [options] injectable for tests
 */
export async function runChat(request, tabId, { watchdog } = {}) {
  const question = typeof request.question === "string" ? request.question.trim() : "";
  if (!question) throw new Error("there is no question to send.");
  if (question.length > MAX_QUESTION) throw new Error(`that question is over ${MAX_QUESTION.toLocaleString("en")} characters.`);

  const detail = await chatPlan(request);
  if (detail.sectionCount === 0) throw new Error("this document has no extracted text to chat about.");
  // Re-read, not trusted from the page: see runOutline in router.js.
  if (!(await isConsented(detail.cacheKey))) return { error: "consent-required", plan: detail };

  const provider = getProvider(detail.providerId);
  if (!(await hasRoomFor(detail.providerId))) {
    throw new ProviderError(`${provider.label} has used its daily quota of ${provider.limits.rpd} requests.`, {
      kind: "rate-limit",
      providerId: detail.providerId,
      quota: true,
    });
  }
  const history = await chatHistory(request.hash);
  const messages = chatMessages(request.sections, request.meta, history, question);
  const tell = (text) => {
    if (tabId === undefined) return;
    browser.tabs.sendMessage(tabId, { type: PROGRESS_MESSAGE, hash: request.hash, text }).catch(() => {});
  };

  const dog = watchdog ?? createWatchdog();
  let reply;
  try {
    reply = await chatText({
      providerId: detail.providerId,
      provider,
      apiKey: await getApiKey(provider.keyRef),
      messages,
      signal: dog.signal,
      onAlive: () => dog.poke(),
      onText: (text) => {
        dog.poke();
        tell(text);
      },
    });
  } catch (err) {
    // A provider that answered counted the request, as in the adapter.
    if (err instanceof ProviderError && err.status) await record(detail.providerId).catch(() => {});
    if (dog.fired) {
      throw new ProviderError(`${provider.label} stopped responding, so the question was abandoned.`, {
        kind: "stalled",
        providerId: detail.providerId,
        cause: err,
      });
    }
    throw err;
  } finally {
    dog.stop();
  }
  await record(detail.providerId).catch((err) => console.warn("[scholar-reader] chat request not counted", err));

  // Saved only once the reply is whole: a failed turn leaves the conversation
  // as it was, and the question stays in the box to send again.
  let warning;
  try {
    await appendTurn(request.hash, question, reply.text, { providerId: detail.providerId, model: provider.model });
  } catch (err) {
    console.warn("[scholar-reader] chat not saved", err);
    warning = `This reply could not be saved, so it will be gone on reopen: ${err.message}`;
  }
  return { reply: reply.text, providerId: detail.providerId, usage: reply.usage, warning };
}

export function chatHandlers() {
  return {
    "chat-plan": (message) => chatPlan(message),
    chat: (message, sender) => runChat(message, sender.tab?.id),
    "chat-history": async ({ hash }) => {
      if (!HASH_RE.test(String(hash))) throw new Error("not a document hash.");
      return { messages: await chatHistory(hash) };
    },
    "chat-clear": async ({ hash }) => {
      if (!HASH_RE.test(String(hash))) throw new Error("not a document hash.");
      await clearChat(hash);
      return { ok: true };
    },
  };
}
