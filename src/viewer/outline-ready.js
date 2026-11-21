// The finished outline, fresh or cached, with what the reader should know about
// where it came from and where else it could go. Split from outline-pane.js,
// which owns the states around the send; this is only the last one.
import { el } from "./el.js";
import { outlineList } from "./outline-list.js";
import { modelChoice } from "./provider-switch.js";

/**
 * @param {object} result the router's outline, or a cache hit
 * @param {object} args
 * @param {(target) => void} args.onJump
 * @param {(index: number) => object[]|undefined} args.linesFor the live
 *   extraction's lines for a section. Located every open, so a cached outline
 *   needs no migration and nothing about a bullet's position is ever stored.
 * @param {object} [args.plan] the plan this outline was made under
 * @param {(id: string) => void} args.onPickProvider
 * @returns {{node: HTMLElement, rendered: object}}
 */
export function readyBox(result, { onJump, linesFor, plan, onPickProvider }) {
  const rendered = outlineList(result, { onJump, linesFor });
  const box = el("div", "outline-ready");
  box.append(rendered.node);
  // It names `result.model` rather than the provider that was asked: fallback
  // may have moved the run, and the reader should see who actually answered. A
  // cache hit says so too — it is the reader's evidence that this open sent
  // nothing anywhere.
  // Who wrote it, as the one model control: picking another re-outlines —
  // from that model's cache if it has one, asking first if not. A cache hit
  // says so: the reader's evidence that this open sent nothing anywhere.
  if (plan?.providerId) {
    box.append(modelChoice(plan, { lead: "Outlined with", onPick: onPickProvider, className: "outline-source" }));
  } else if (result.model) {
    box.append(el("p", "outline-source", `Outlined by ${result.model}.`));
  }
  if (result.cacheHit) box.append(el("p", "outline-cache", "From this paper's cache; nothing was sent."));
  // Non-fatal: the outline is on screen either way, and the only consequence
  // is another run next time. Saying so beats silence.
  if (result.warning) box.append(el("p", "pane-note", result.warning));
  return { node: box, rendered };
}
