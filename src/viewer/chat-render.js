// Drawing the chat tab's pieces: a reply's text with its section links, and the
// line that says where questions go. DOM calls only — a reply is model output,
// never markup.
import { splitCitations } from "../model/chat-prompt.js";
import { el } from "./el.js";

/**
 * A reply as paragraphs and "- " lists, with each [§ Title] that matches an
 * extracted section turned into a link to it. The link's target is that
 * section's own page and y, from the extraction on this machine.
 *
 * @param {string} text
 * @param {{title: string, page: number, y: number}[]} sections
 * @param {(target: {page: number, y: number}) => void} onJump
 */
export function replyBody(text, sections, onJump) {
  const body = el("div", "chat-body");
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim());
    if (!lines.length) continue;
    if (lines.every((line) => /^\s*[-•*]\s+/.test(line))) {
      const list = el("ul", "chat-list");
      for (const line of lines) {
        const item = el("li");
        inline(item, line.replace(/^\s*[-•*]\s+/, ""), sections, onJump);
        list.append(item);
      }
      body.append(list);
    } else {
      const para = el("p");
      inline(para, lines.join("\n"), sections, onJump);
      body.append(para);
    }
  }
  return body;
}

function inline(node, text, sections, onJump) {
  for (const part of splitCitations(text, sections)) {
    if (part.text !== undefined) {
      node.append(el("span", null, part.text));
      continue;
    }
    const { page, y } = sections[part.index];
    const link = el("button", "chat-cite", `§ ${part.cite}`);
    link.type = "button";
    link.title = `Go to “${part.cite}”, page ${page}`;
    link.addEventListener("click", () => onJump?.({ page, y }));
    node.append(link);
  }
}

/** One message in the log. */
export function messageNode({ role, content, label }, sections, onJump) {
  const node = el("div", `chat-msg is-${role}`);
  if (role === "user") {
    node.append(el("p", "chat-question", content));
  } else {
    node.append(replyBody(content, sections, onJump));
    if (label) node.append(el("p", "chat-by", label));
  }
  return node;
}

const WHERE = {
  anthropic: (plan) => `Anthropic (${plan.label.replace(/\s*\(via Claude Code\)$/, "")}), through Claude Code on your subscription`,
  google: (plan) => `Google (${plan.label}), with your Gemini API key`,
};

/**
 * What pressing Send does, said before it is pressed: the whole paper goes again
 * with every question, plus the conversation so far, and where it goes. Pressing
 * Send is the approval, so this line is what the reader agrees to.
 */
export function disclosure(plan) {
  const where = (WHERE[plan.destination] ?? ((p) => `${p.destination} (${p.label})`))(plan);
  const nodes = [
    el(
      "span",
      null,
      plan.viaPdf
        ? `Send shares this PDF (~${plan.estTokens.toLocaleString("en")} tokens) and the conversation so far with ${where}.`
        : `Send shares this paper's text (~${plan.estTokens.toLocaleString("en")} tokens) and the conversation so far with ${where}.`,
    ),
  ];
  if (!plan.hasKey) {
    const missing = plan.bridge ? "No bridge token is stored yet" : "No Gemini API key is stored yet";
    nodes.push(el("span", "chat-where-warn", ` ${missing} — add one in settings.`));
  }
  return nodes;
}

/** "Start a new chat?" as a state of the pane: one click to clear, one to keep. */
export function newChatPrompt({ count, onConfirm, onCancel }) {
  const box = el("div", "chat-new-prompt");
  box.append(el("p", null, `Start a new chat? This clears the current conversation (${count} question${count === 1 ? "" : "s"}).`));
  const row = el("div", "chat-new-row");
  const go = el("button", "confirm-go", "Start new chat");
  go.type = "button";
  go.addEventListener("click", onConfirm);
  const keep = el("button", "confirm-alt-go", "Keep this one");
  keep.type = "button";
  keep.addEventListener("click", onCancel);
  row.append(go, keep);
  box.append(row);
  return box;
}
