// The parts both provider transports need: decoding the JSON body a model was
// asked to produce, and the two failures that are about *where* a request went
// rather than how it was shaped.
import { ProviderError } from "./errors.js";

/**
 * @param {string} content the accumulated response body
 * @param {string} providerId
 * @returns {object} the parsed JSON
 */
export function decodeJson(content, providerId) {
  if (!content.trim()) {
    throw new ProviderError("The model returned an empty response.", { kind: "malformed", providerId });
  }
  try {
    return JSON.parse(content);
  } catch (cause) {
    // CLAUDE.md: prose parsing is never a fallback. A malformed response is an
    // error the reader sees.
    throw new ProviderError("The model's response was not valid JSON.", {
      kind: "malformed",
      providerId,
      cause,
    });
  }
}

// Ollama checks the Origin header server-side. This is not browser CORS, so no
// permission grant and no host_permissions entry fixes it — the server has to
// be told to accept the extension's origin, and how depends on how it was
// started. The macOS desktop app is launched by launchd and never sees a
// shell's environment, so the terminal form alone is the wrong remedy for the
// way this user actually runs it (PROGRESS.md, 2026-09-13).
export function originRefusedError(providerId, status) {
  return new ProviderError(
    "Ollama refused this request's origin. It checks the Origin header itself, so this is not " +
      "browser CORS and no permission fixes it. Desktop app: run " +
      '`launchctl setenv OLLAMA_ORIGINS "moz-extension://*"` and restart Ollama from the menu bar. ' +
      'Terminal: start it with `OLLAMA_ORIGINS="moz-extension://*" ollama serve`. ' +
      "The launchctl setting does not survive a reboot, so this can come back.",
    { kind: "origin-refused", providerId, status },
  );
}

/** A request that never reached the provider at all. */
export function networkError(cause, providerId, provider) {
  if (cause?.name === "AbortError") return cause;
  const remedy =
    provider.destination === "local"
      ? ` Is Ollama running at ${provider.baseUrl}?`
      : " Check the network connection.";
  return new ProviderError(`Could not reach ${provider.label}.${remedy}`, {
    kind: "network",
    providerId,
    cause,
  });
}
