// The "Details" under an error in the pane: what the reader can copy and send
// back when something fails in a way the message alone does not explain.
//
// Built for the container case (2026-09-27): a refusal that came back after an
// approval looked like a flicker, with nothing on screen to say why. Nothing in
// here is secret — keys never reach the viewer — and nothing leaves the page.

const HK_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  dateStyle: "medium",
  timeStyle: "medium",
});

// The tab's container, which is the thing that decides which IndexedDB
// partition an extension page sees. Best-effort: absent outside a tab.
async function container() {
  try {
    return (await browser.tabs.getCurrent())?.cookieStoreId ?? "no tab";
  } catch (err) {
    return `unknown (${err?.message ?? err})`;
  }
}

function version() {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
}

// A plan carries every section title; the details only need what identifies it.
function trim(value) {
  if (!value || typeof value !== "object") return value;
  const { sectionTitles, outline, alternatives, otherProviders, order, ...rest } = value;
  return { ...rest, ...(rest.plan ? { plan: trim(rest.plan) } : {}) };
}

/**
 * @param {Record<string, unknown>} facts what the caller knows about the failure
 * @returns {Promise<string>} plain text, one fact per line
 */
export async function describeFailure(facts) {
  const lines = [
    `When: ${HK_TIME.format(new Date())} (Hong Kong)`,
    `Scholar Reader: ${version()}`,
    `Container: ${await container()}`,
  ];
  for (const [name, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    lines.push(`${name}: ${typeof value === "string" ? value : JSON.stringify(trim(value), null, 2)}`);
  }
  return lines.join("\n");
}
