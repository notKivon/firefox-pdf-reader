// The per-origin opt-out list. Read live by background/intercept.js through
// `storage.onChanged`, so a save applies to the next PDF without a reload.
import { getOptOutHosts, normalizeHosts, setOptOutHosts } from "../store/settings.js";
import { act, button, el, statusLine } from "./ui.js";

export async function renderHosts(body) {
  const status = statusLine();
  const area = el("textarea");
  area.spellcheck = false;
  area.setAttribute("aria-label", "Hosts that keep the browser's own PDF viewer");
  area.value = (await getOptOutHosts()).join("\n");

  const save = button("Save", () =>
    act([save], status, "save the list", async () => {
      // Nothing is saved while any line is unreadable: a typo that silently
      // dropped would look like an opt-out that does not work.
      const { hosts, rejected } = normalizeHosts(area.value);
      if (rejected.length) {
        return status.error(`Not saved — not a host name: ${rejected.join(", ")}`);
      }
      const saved = await setOptOutHosts(hosts);
      area.value = saved.join("\n");
      status.ok(saved.length ? `Saved ${saved.length} host${saved.length === 1 ? "" : "s"}.` : "Saved. Every PDF opens in Scholar Reader.");
    }),
  );

  const row = el("div", "settings-row");
  row.append(save);
  body.replaceChildren(area, row, status.node);
}
