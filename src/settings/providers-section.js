// Provider order, with each provider's destination and today's quota beside it.
import { getProvider } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { status as quotaStatus } from "../store/quota.js";
import { getProviderOrder, setProviderOrder } from "../store/settings.js";
import { destinationText, moveItem } from "./model.js";
import { act, button, el, statusLine } from "./ui.js";

export async function renderProviders(body) {
  const status = statusLine();
  const list = el("ol", "settings-list");

  const draw = async (order) => {
    const items = [];
    for (const [index, id] of order.entries()) items.push(await item(order, index, id, status, draw));
    list.replaceChildren(...items);
  };

  await draw(await getProviderOrder());
  body.replaceChildren(list, status.node);
}

async function item(order, index, id, status, draw) {
  const provider = getProvider(id);
  const li = el("li");

  const top = el("div", "settings-row");
  const name = el("strong", "grow", provider.label);
  const up = button("↑", () => move(-1));
  const down = button("↓", () => move(1));
  up.setAttribute("aria-label", `Move ${provider.label} up`);
  down.setAttribute("aria-label", `Move ${provider.label} down`);
  up.disabled = index === 0;
  down.disabled = index === order.length - 1;
  top.append(name, ...(index === 0 ? [el("span", "settings-dim", "default")] : []), up, down);

  const facts = [provider.model, destinationText(provider.destination)];
  if (provider.keyRef && !(await getApiKey(provider.keyRef).catch(() => null))) facts.push("no key stored");
  li.append(top, el("div", "settings-dim", facts.join(" · ")));
  if (provider.limits?.rpd) li.append(el("div", "settings-dim", await quotaText(id)));

  async function move(delta) {
    await act([up, down], status, "save the provider order", async () => {
      const saved = await setProviderOrder(moveItem(order, index, delta));
      await draw(saved);
      status.ok(`Saved. ${getProvider(saved[0]).label} is the default.`);
    });
  }
  return li;
}

async function quotaText(id) {
  try {
    const q = await quotaStatus(id);
    return `${q.used.toLocaleString("en")} of ${q.rpd.toLocaleString("en")} requests used today · resets ${q.resetsAtText}`;
  } catch (err) {
    return `Today's usage could not be read: ${err?.message ?? err}`;
  }
}
