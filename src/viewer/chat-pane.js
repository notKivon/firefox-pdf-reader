// The chat tab: ask questions about the open paper.
//
// Send is the approval (changed 2026-11-18 at the user's request): the line
// above the box says where questions go and what goes with them, before the
// first one. Pressing Send has the router record the grant for this paper and
// model, then sends. The router re-reads that grant itself before any call
// (background/chat.js), so nothing leaves without one on record.
import { ask } from "./ask.js";
import { disclosure, messageNode } from "./chat-render.js";
import { el } from "./el.js";
import { errorBox } from "./pane-error.js";

// As in outline-pane.js: lines stay on this page.
const forSending = (sections) => sections.map(({ lines, ...rest }) => rest);
const shortLabel = (label) => String(label ?? "").replace(/\s*\(via Claude Code\)$/, "");

export function createChatPane({ root, onJump }) {
  let doc = null; // {hash, meta, sections}
  let plan = null; // the router's chat plan for the chosen model
  let history = [];
  let pending = null; // the assistant bubble being streamed into
  let busy = false;
  let empty = null; // the "no questions yet" line, while it is shown

  const log = el("div", "chat-log");
  const notice = el("div", "chat-notice");
  const where = el("p", "chat-where");
  const input = el("textarea", "chat-input");
  input.rows = 3;
  input.placeholder = "Ask about this paper…";
  input.setAttribute("aria-label", "Question about this paper");
  const sendButton = el("button", "confirm-go chat-send", "Send");
  sendButton.type = "button";
  const picker = el("select", "chat-model");
  picker.setAttribute("aria-label", "Model");
  const clearButton = el("button", "confirm-alt-go chat-clear", "Clear");
  clearButton.type = "button";

  const head = el("div", "chat-head");
  head.append(picker, clearButton);
  const composer = el("div", "chat-composer");
  composer.append(notice, where, input, sendButton);

  const sections = () => doc?.sections ?? [];
  const setBusy = (value) => {
    busy = value;
    sendButton.disabled = value;
    picker.disabled = value;
    clearButton.disabled = value;
  };

  function drawLog() {
    const nodes = history.map((m) =>
      messageNode({ ...m, label: m.role === "assistant" ? shortLabel(labelFor(m.providerId)) : null }, sections(), onJump),
    );
    empty = nodes.length ? null : el("p", "pane-placeholder", "No questions yet. Ask anything about the paper.");
    log.replaceChildren(...(empty ? [empty] : nodes));
  }
  const labelFor = (id) => plan?.providers?.find((p) => p.id === id)?.label ?? id;

  function drawPicker() {
    picker.replaceChildren(
      ...(plan?.providers ?? []).map(({ id, label }) => {
        const option = el("option", null, shortLabel(label));
        option.value = id;
        option.selected = id === plan.providerId;
        return option;
      }),
    );
  }

  function showFrame() {
    root.replaceChildren(head, log, composer);
    drawPicker();
    drawLog();
  }

  async function replan(providerId) {
    plan = await ask({ type: "chat-plan", hash: doc.hash, sections: forSending(doc.sections), meta: doc.meta, providerId });
    drawPicker();
    where.replaceChildren(...disclosure(plan));
  }

  async function submit() {
    const question = input.value.trim();
    if (!question || busy || !plan) return;
    notice.replaceChildren();
    if (!plan.consented) {
      await ask({ type: "grant", kind: "chat", hash: doc.hash, providerId: plan.providerId, cacheKey: plan.cacheKey });
      plan = { ...plan, consented: true };
    }
    await send(question);
  }

  async function send(question) {
    setBusy(true);
    const asked = { role: "user", content: question };
    pending = el("div", "chat-msg is-assistant is-pending");
    pending.append(el("p", "pane-placeholder", `${shortLabel(plan.label)} is reading the paper…`));
    if (empty) log.replaceChildren();
    empty = null;
    log.append(messageNode(asked, sections(), onJump), pending);
    pending.scrollIntoView?.({ block: "end" });
    let result;
    try {
      result = await browser.runtime.sendMessage({
        type: "chat",
        hash: doc.hash,
        sections: forSending(doc.sections),
        meta: doc.meta,
        providerId: plan.providerId,
        question,
      });
    } catch (err) {
      result = { error: "internal", message: String(err?.message ?? err) };
    } finally {
      pending = null;
      setBusy(false);
    }
    if (result?.error === "consent-required") {
      plan = result.plan;
      drawLog();
      return submit();
    }
    if (result?.error || result === undefined) {
      drawLog();
      const text = result?.message ?? "The background did not answer.";
      notice.replaceChildren(errorBox(`Your question was not answered: ${text}`, { retry: () => submit().catch(fail) }));
      return;
    }
    input.value = "";
    history = [...history, { ...asked, providerId: result.providerId }, { role: "assistant", content: result.reply, providerId: result.providerId }];
    drawLog();
    if (result.warning) notice.replaceChildren(el("p", "pane-note", result.warning));
  }

  // Each streamed delta carries the whole reply so far, so a dropped message
  // costs nothing but one redraw.
  function progress(message) {
    if (!pending || message.hash !== doc?.hash) return;
    pending.replaceChildren(messageNode({ role: "assistant", content: message.text }, sections(), onJump));
  }

  let confirming = false;
  clearButton.addEventListener("click", () => {
    if (!history.length) return;
    if (!confirming) {
      confirming = true;
      clearButton.textContent = "Clear the whole conversation?";
      setTimeout(() => {
        confirming = false;
        clearButton.textContent = "Clear";
      }, 4000);
      return;
    }
    confirming = false;
    clearButton.textContent = "Clear";
    ask({ type: "chat-clear", hash: doc.hash })
      .then(() => {
        history = [];
        drawLog();
      })
      .catch(fail);
  });
  sendButton.addEventListener("click", () => submit().catch(fail));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit().catch(fail);
    }
  });
  picker.addEventListener("change", () => {
    notice.replaceChildren();
    replan(picker.value).catch(fail);
  });

  function fail(err) {
    console.error("[scholar-reader] chat failed", err);
    setBusy(false);
    notice.replaceChildren(errorBox(String(err?.message ?? err)));
  }

  function message(text) {
    root.replaceChildren(el("p", "pane-placeholder", text));
  }

  /** @param {{hash, sections, meta, scanned}} extraction */
  async function start({ hash, sections: all, meta, scanned }) {
    if (scanned) return message("This looks like a scanned PDF — there is no text to chat about, and nothing was sent.");
    if (!all.some((section) => section.text.trim())) return message("No text could be extracted from this document, so there is nothing to chat about.");
    doc = { hash, meta, sections: all };
    try {
      const [past] = await Promise.all([ask({ type: "chat-history", hash }), replan(undefined)]);
      history = past.messages;
      showFrame();
    } catch (err) {
      showFrame();
      fail(err);
    }
  }

  message("Waiting for the text layer…");
  return { start, progress, fail: (text) => message(text) };
}
