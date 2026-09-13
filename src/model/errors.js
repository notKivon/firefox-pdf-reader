// One error type for everything that can go wrong between the adapter and a
// provider, because every one of these has to reach the outline pane as words.
// CLAUDE.md: a failed model call must never leave the pane in a silent spinner.
//
// `kind` is what the caller branches on; `message` is what the reader sees.

export class ProviderError extends Error {
  /**
   * @param {string} message reader-facing text
   * @param {object} info
   * @param {"rate-limit"|"auth"|"network"|"origin-refused"|"malformed"|"too-large"|"http"|"exhausted"|"cancelled"} info.kind
   * @param {string} [info.providerId]
   * @param {number} [info.status] HTTP status when there was a response
   * @param {number} [info.retryAfterMs] from a Retry-After header
   * @param {boolean} [info.quota] true when the day's own counter refused the
   *   run before it was dispatched, rather than the provider answering 429
   * @param {string} [info.resetsAtText] when the daily quota comes back, in
   *   Asia/Hong_Kong — the fact that decides whether to wait or switch
   * @param {string[]} [info.tried] provider ids attempted, for "exhausted"
   * @param {string[]} [info.otherDestinations] provider ids on another
   *   destination, which the user may choose but nothing may reach automatically
   * @param {unknown} [info.cause]
   */
  constructor(
    message,
    { kind, providerId, status, retryAfterMs, quota, resetsAtText, tried, otherDestinations, cause } = {},
  ) {
    super(message, { cause });
    this.name = "ProviderError";
    this.kind = kind ?? "http";
    this.providerId = providerId;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.quota = quota ?? false;
    this.resetsAtText = resetsAtText;
    this.tried = tried;
    this.otherDestinations = otherDestinations;
  }

  // Errors do not survive `runtime.sendMessage`'s structured clone as errors, so
  // the router sends this and the pane renders it.
  toJSON() {
    return {
      error: this.kind,
      message: this.message,
      providerId: this.providerId,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      quota: this.quota,
      resetsAtText: this.resetsAtText,
      tried: this.tried,
      otherDestinations: this.otherDestinations,
    };
  }
}

// A 429 or a quota refusal is the only thing automatic fallback reacts to. An
// auth failure or a malformed response would fail identically on the next
// provider, so those stop where they happen.
export const isFallbackWorthy = (err) => err instanceof ProviderError && err.kind === "rate-limit";

// Under `per-section`, whether a failure belongs to the one section that hit it
// or to the whole run. A malformed answer and a section that will not fit the
// context window are both about this section's own request; a rate limit, a bad
// key or the network would fail the next request identically.
export const isSectionLocal = (err) =>
  err instanceof ProviderError && (err.kind === "malformed" || err.kind === "too-large");
