// Two real chat turns through a running bridge, with the extension's own prompt
// and transport: `node tools/chat-probe.mjs [fixture] [provider] [port]`.
// Spends subscription usage; tools/test/chat.test.mjs does not.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatMessages, splitCitations } from "../src/model/chat-prompt.js";
import { chatText } from "../src/model/openai-compat.js";
import { PROVIDERS } from "../src/model/providers.js";

const [fixture = "adam", providerId = "claude-opus", port = "8765"] = process.argv.slice(2);
const token = readFileSync(join(homedir(), ".config", "scholar-reader", "bridge-token"), "utf8").trim();
const provider = { ...PROVIDERS[providerId], baseUrl: `http://127.0.0.1:${port}/v1/` };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  realFetch(url, { ...init, headers: { ...(init.headers ?? {}), Origin: "moz-extension://probe" } });

const doc = JSON.parse(readFileSync(new URL(`../fixtures/${fixture}.json`, import.meta.url), "utf8"));
const history = [];
for (const question of [
  "In two or three sentences, what problem does this paper solve?",
  "Which section explains why bias correction matters, and what is the argument?",
]) {
  const started = Date.now();
  let updates = 0;
  const { text, usage } = await chatText({
    providerId,
    provider,
    apiKey: token,
    messages: chatMessages(doc.sections, { title: doc.name }, history, question),
    onText: () => updates++,
  });
  const parts = splitCitations(text, doc.sections);
  const linked = parts.filter((p) => p.cite).map((p) => p.cite);
  const unmatched = [...text.matchAll(/\[§[^\]]*\]/g)].length - linked.length;
  console.log(`\nQ: ${question}\n(${Math.round((Date.now() - started) / 1000)} s, ${updates} updates, ` +
    `${usage?.prompt_tokens} in / ${usage?.completion_tokens} out; links ${JSON.stringify(linked)}, unmatched ${unmatched})\n${text}`);
  history.push({ role: "user", content: question }, { role: "assistant", content: text });
}
