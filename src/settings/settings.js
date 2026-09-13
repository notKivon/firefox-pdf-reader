// Settings page entry. Each section loads on its own, so one store failing
// shows an error in that section and leaves the others usable.
import { initTheme } from "../viewer/theme.js";
import { renderConsents } from "./consents-section.js";
import { renderHosts } from "./hosts-section.js";
import { renderKeys } from "./keys-section.js";
import { renderProviders } from "./providers-section.js";
import { renderSection } from "./ui.js";

const body = (id) => document.querySelector(`#${id} .settings-body`);

async function main() {
  await initTheme(document.getElementById("theme-toggle"));
  await Promise.all([
    renderSection(body("keys"), "API keys", renderKeys),
    renderSection(body("providers"), "provider list", renderProviders),
    renderSection(body("hosts"), "site list", renderHosts),
    renderSection(body("consents"), "approval list", renderConsents),
  ]);
}

main().catch((err) => {
  console.error("[scholar-reader] settings failed to start", err);
  document.body.append(Object.assign(document.createElement("p"), { className: "settings-status error", textContent: `Settings failed to load: ${err?.message ?? err}` }));
});
