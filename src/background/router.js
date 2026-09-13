// The message router: the ONLY place a provider is ever called.
//
// Two reasons it lives here rather than in the viewer (SPEC.md): background
// fetches to hosts in `host_permissions` are not subject to CORS, and no API key
// ever reaches the viewer context. A third, from CLAUDE.md: the send
// confirmation gate is enforced here, so a viewer that forgets to ask cannot
// cause a send.
import { outline as generateOutline } from "../model/adapter.js";
import { ProviderError } from "../model/errors.js";
import { getProvider, PROVIDERS } from "../model/providers.js";
import { getApiKey } from "../store/apikeys.js";
import { isConsented } from "../store/consent.js";
import { isCacheable, saveOutline } from "../store/outlines.js";
import { status as quotaStatus } from "../store/quota.js";
import { plan } from "./plan.js";
import { createWatchdog } from "./watchdog.js";

export { plan };

const PROGRESS_MESSAGE = "outline-progress";

/**
 * @param {{hash, sections, meta, providerId}} request
 * @param {number|undefined} tabId the tab to stream progress to
 * @param {{watchdog?: object}} [options] injectable for tests
 */
export async function runOutline(request, tabId, { watchdog } = {}) {
  const detail = await plan(request);
  // Zero network requests on a hit — a correctness requirement rather than an
  // optimisation, and the reason this check sits ahead of the consent gate:
  // there is no send to gate.
  if (detail.cacheHit) return { ...detail.outline, cacheHit: true };

  // Deliberately re-read rather than trusting `detail.consented`: the gate is
  // the router's own read of the store, so nothing the viewer sends — a stubbed
  // check, a forged flag on the message — can stand in for a grant.
  if (!(await isConsented(detail.cacheKey))) {
    // Not an error the pane reports as a failure: it is the card's cue.
    return { error: "consent-required", plan: detail };
  }

  const tell = (payload) => {
    if (tabId === undefined) return;
    browser.tabs.sendMessage(tabId, { type: PROGRESS_MESSAGE, hash: request.hash, ...payload }).catch(() => {
      // The viewer navigated away mid-run. The result still completes and is
      // still cached; there is simply no one to show it to.
    });
  };

  const dog = watchdog ?? createWatchdog();
  let result;
  try {
    result = await generateOutline({
      sections: request.sections,
      providerId: detail.providerId,
      meta: request.meta,
      order: detail.order,
      resolveKey: getApiKey,
      signal: dog.signal,
      onProgress: (partial) => {
        dog.poke();
        tell(partial);
      },
      onProviderChange: (id) => {
        dog.poke();
        tell({ providerId: id });
      },
    });
  } catch (err) {
    if (dog.fired) throw stalled(detail, dog.ms, err);
    throw err;
  } finally {
    dog.stop();
  }

  return { ...result, ...(await cache(request.hash, result)) };
}

function stalled(detail, ms, cause) {
  const minutes = Math.round(ms / 60_000);
  const label = getProvider(detail.providerId).label;
  const hint = detail.destination === "local" ? " If Ollama is still loading the model, trying again usually works." : "";
  return new ProviderError(
    `${label} stopped responding — nothing arrived for ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
      `so the request was abandoned and nothing was cached.${hint}`,
    { kind: "stalled", providerId: detail.providerId, cause },
  );
}

/**
 * Caching is the last thing that happens and the only one allowed to fail
 * quietly: the outline is already on screen, and a paper the reader can read is
 * worth more than one they cannot because the write failed. The cost of the
 * miss is one more request next time, which the note says out loud.
 */
async function cache(hash, result) {
  // A run with malformed sections in it is a partial outline; caching it would
  // make the gaps permanent, since the next open would be a hit.
  if (!isCacheable(result)) {
    return { warning: "Some sections could not be summarised, so this outline was not cached." };
  }
  try {
    await saveOutline(hash, result);
    return {};
  } catch (err) {
    console.warn("[scholar-reader] outline not cached", err);
    return { warning: `This outline could not be cached, so reopening will generate it again: ${err.message}` };
  }
}

/** @param {{bypass: {grant(tabId: number): boolean}}} deps */
function handlers({ bypass }) {
  return {
    plan: (message) => plan(message),
    outline: (message, sender) => runOutline(message, sender.tab?.id),
    // Read-only: what today's counters stand at, for the settings page.
    quota: async () => ({
      providers: await Promise.all(
        Object.keys(PROVIDERS)
          .filter((id) => PROVIDERS[id].limits?.rpd)
          .map((id) => quotaStatus(id)),
      ),
    }),
    // The escape hatch: the sending tab's next PDF opens in the browser's own
    // viewer. Only a tab may ask, and only for itself.
    bypass: async (_message, sender) => {
      if (!bypass.grant(sender.tab?.id)) {
        return { error: "internal", message: "Only a Scholar Reader tab can ask for the browser's own viewer." };
      }
      return { ok: true };
    },
  };
}

/**
 * Firefox resolves a promise returned from an onMessage listener, so every
 * handler can be async. Errors are converted rather than thrown: an Error does
 * not survive the structured clone, and CLAUDE.md requires every async boundary
 * to surface in the UI rather than hang.
 */
export function registerRouter(deps) {
  const table = handlers(deps);
  browser.runtime.onMessage.addListener((message, sender) => {
    const handler = table[message?.type];
    if (!handler) return undefined;
    return handler(message, sender).catch((err) => {
      console.error(`[scholar-reader] ${message.type} failed`, err);
      if (err instanceof ProviderError) return err.toJSON();
      return { error: "internal", message: String(err?.message ?? err) };
    });
  });
}
