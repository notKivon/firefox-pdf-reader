// Stored send approvals, per document, each revocable.
//
// Read and revoked through the router: the grants the gate checks are in the
// background's partition of IndexedDB, and this page — opened from a reader tab
// in a container — may have a partition of its own.
import { ask } from "../viewer/ask.js";
import { destinationText, groupGrants } from "./model.js";
import { act, button, el, statusLine } from "./ui.js";

export async function renderConsents(body) {
  const status = statusLine();
  const list = el("ul", "settings-list");
  const header = el("div", "settings-row");

  const draw = async () => {
    // A missing or unreadable document record costs the title, not the list.
    const { consents, docs } = await ask({ type: "consents" });
    const groups = groupGrants(consents, new Map(Object.entries(docs)));

    if (groups.length === 0) {
      header.replaceChildren(el("span", "settings-dim", "No document has been approved for sending."));
      list.replaceChildren();
      return;
    }
    const all = button("Revoke all", () =>
      act([all], status, "revoke every approval", async () => {
        const { count: n } = await ask({ type: "revoke", all: true });
        await draw();
        status.ok(`Revoked ${n} approval${n === 1 ? "" : "s"}.`);
      }),
    );
    header.replaceChildren(el("span", "settings-dim grow", `${groups.length} document${groups.length === 1 ? "" : "s"}`), all);
    list.replaceChildren(...groups.map((group) => row(group, status, draw)));
  };

  await draw();
  body.replaceChildren(header, list, status.node);
}

function row(group, status, draw) {
  const li = el("li");
  const top = el("div", "settings-row");
  const revoke = button("Revoke", () =>
    act([revoke], status, "revoke the approval", async () => {
      const { count: n } = await ask({ type: "revoke", hash: group.hash });
      await draw();
      status.ok(`Revoked ${n} approval${n === 1 ? "" : "s"} for “${group.title}”.`);
    }),
  );
  top.append(el("strong", "grow", group.title), revoke);

  const grants = el("ul");
  for (const grant of group.grants) {
    grants.append(el("li", "", `${grant.label} (${grant.model}) — ${destinationText(grant.destination)} — approved ${grant.when}`));
  }
  li.append(top, grants);
  return li;
}
