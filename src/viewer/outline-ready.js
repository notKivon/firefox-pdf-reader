// The finished outline, fresh or cached, with what the reader should know about
// where it came from and where else it could go. Split from outline-pane.js,
// which owns the states around the send; this is only the last one.
import { el } from "./el.js";
import { outlineList } from "./outline-list.js";
import { providerSwitch } from "./provider-switch.js";

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
  if (result.model) {
    const source = result.cacheHit
      ? `Outlined by ${result.model}, from this document's cache — nothing was sent.`
      : `Outlined by ${result.model}.`;
    box.append(el("p", "outline-source", source));
  }
  // Non-fatal: the outline is on screen either way, and the only consequence
  // is another run next time. Saying so beats silence.
  if (result.warning) box.append(el("p", "pane-note", result.warning));
  // A finished outline is not the end of the reader's choices. Re-planning
  // under another model is a different cache key, so it renders from that
  // model's cache if it has one and asks for its own confirmation if not —
  // crossing to the local model included.
  const switcher = providerSwitch(plan, onPickProvider);
  if (switcher) box.append(switcher);
  return { node: box, rendered };
}
