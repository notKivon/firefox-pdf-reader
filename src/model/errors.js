// One error type for everything that can go wrong between the adapter and a
// provider, because every one of these has to reach the outline pane as words.
// CLAUDE.md: a failed model call must never leave the pane in a silent spinner.
//
// `kind` is what the caller branches on; `message` is what the reader sees.

export class ProviderError extends Error {
  /**
   * @param {string} message reader-facing text
   * @param {object} info
   * @param {"rate-limit"|"auth"|"network"|"origin-refused"|"malformed"|"http"|"exhausted"|"cancelled"} info.kind
   * @param {string} [info.providerId]
   * @param {number} [info.status] HTTP status when there was a response
   * @param {number} [info.retryAfterMs] from a Retry-After header
   * @param {string[]} [info.tried] provider ids attempted, for "exhausted"
   * @param {string[]} [info.otherDestinations] provider ids on another
   *   destination, which the user may choose but nothing may reach automatically
   * @param {unknown} [info.cause]
   */
  constructor(message, { kind, providerId, status, retryAfterMs, tried, otherDestinations, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.kind = kind ?? "http";
    this.providerId = providerId;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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
      tried: this.tried,
      otherDestinations: this.otherDestinations,
    };
  }
}

// A 429 or a quota refusal is the only thing automatic fallback reacts to. An
// auth failure or a malformed response would fail identically on the next
// provider, so those stop where they happen.
export const isFallbackWorthy = (err) => err instanceof ProviderError && err.kind === "rate-limit";
