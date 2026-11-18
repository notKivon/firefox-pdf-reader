// Drawing the chat tab's pieces: a reply's text with its section links, and the
// approval card. DOM calls only — a reply is model output, never markup.
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

/**
 * The approval, as a state of the pane (CLAUDE.md: never a modal). It says what
 * every question sends — the whole paper again, plus the conversation — and
 * where, before anything is sent.
 */
export function chatCard(plan, { onApprove, onCancel }) {
  const card = el("div", "confirm-card chat-card");
  card.append(
    el("h2", "confirm-heading", "Chat about this paper?"),
    el("p", "confirm-doc", plan.title || "Untitled document"),
    el(
      "p",
      "confirm-meta",
      [
        `${plan.pageCount} pages`,
        `${plan.sectionCount} sections`,
        `~${plan.estTokens.toLocaleString("en")} tokens per question, est.`,
      ].join(" · "),
    ),
    el(
      "p",
      "confirm-dest",
      `Sent to Anthropic — ${plan.label} (${plan.model}), through Claude Code on your subscription. ` +
        "Each question sends the paper again, with the conversation so far.",
    ),
  );
  if (!plan.hasKey) {
    card.append(el("p", "confirm-warn", "No bridge token is stored yet — add one in settings."));
  }
  const row = el("div", "chat-card-row");
  const go = el("button", "confirm-go", "Send");
  go.type = "button";
  go.addEventListener("click", onApprove);
  const cancel = el("button", "confirm-alt-go", "Not now");
  cancel.type = "button";
  cancel.addEventListener("click", onCancel);
  row.append(go, cancel);
  card.append(row);
  return card;
}
