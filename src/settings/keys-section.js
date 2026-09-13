// API key entry. The field is never filled with the stored key: it only ever
// shows the last four characters, enough to recognise which key is in place.
import { getApiKey, setApiKey } from "../store/apikeys.js";
import { keyRefs, maskKey } from "./model.js";
import { act, button, el, statusLine } from "./ui.js";

export async function renderKeys(body) {
  const rows = [];
  for (const { ref, users } of keyRefs()) rows.push(await keyRow(ref, users));
  body.replaceChildren(...rows);
}

async function keyRow(ref, users) {
  const wrap = el("div");
  const state = el("span", "settings-dim grow");
  const status = statusLine();

  const refresh = async () => {
    const masked = maskKey(await getApiKey(ref));
    state.textContent = masked ? `Key stored (${masked})` : "No key stored";
  };

  const input = el("input", "grow");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Paste a new key";
  input.setAttribute("aria-label", `API key for ${ref}`);

  const save = button("Save", () =>
    act([save, clear], status, "save the key", async () => {
      const value = input.value.trim();
      if (!value) return status.error("Paste a key first — use Clear to remove the stored one.");
      if (/\s/.test(value)) return status.error("That key contains spaces; check it was copied whole.");
      await setApiKey(ref, value);
      input.value = "";
      await refresh();
      status.ok("Saved. Reopen a paper for it to take effect.");
    }),
  );
  const clear = button("Clear", () =>
    act([save, clear], status, "clear the key", async () => {
      await setApiKey(ref, "");
      await refresh();
      status.ok("Key removed.");
    }),
  );

  const heading = el("div", "settings-row");
  heading.append(el("strong", "", ref === "gemini" ? "Google AI Studio" : ref), state);
  const used = el("div", "settings-dim", `Used by ${users.join(", ")}`);
  const entry = el("div", "settings-row");
  entry.append(input, save, clear);
  wrap.append(heading, used, entry, status.node);
  await refresh();
  return wrap;
}
