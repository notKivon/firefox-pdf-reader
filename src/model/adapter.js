// The one entry point the rest of the application uses to turn extracted
// sections into an outline.
//
// CLAUDE.md: chunking strategy is a property of the provider, not of the task.
// Callers ask for an outline of a document; they never loop over sections
// themselves and never learn which strategy served them.
import { attachTargets } from "./align.js";
import { ProviderError, isFallbackWorthy } from "./errors.js";
import { chatJson } from "./openai-compat.js";
import { fallbacksFor, getProvider, PROVIDERS } from "./providers.js";
import { outlineSchema, sectionMessages, tldrMessages, tldrSchema, wholeDocumentMessages } from "./prompts.js";

// Enough to keep a per-section run busy without tripping a per-minute limit.
const CONCURRENCY = 3;

/**
 * @param {object} args
 * @param {{title: string, page: number, y: number, text: string}[]} args.sections
 * @param {string} args.providerId the provider to start with
 * @param {(keyRef: string) => Promise<string|null>} args.resolveKey
 * @param {object} [args.meta] `{title, pageCount}` for the prompt header
 * @param {(partial: {sections: object[]}) => void} [args.onProgress] sections
 *   complete so far, in sent order, for progressive fill
 * @param {(providerId: string) => void} [args.onProviderChange] fired when
 *   fallback moves the run to another provider of the same destination
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{sections, tldr, providerId, model, strategy, usage}>}
 */
export async function outline({ sections, providerId, resolveKey, meta, onProgress, onProviderChange, signal }) {
  // CLAUDE.md keeps empty-text sections (a parent heading whose first subsection
  // follows immediately) because they carry the paper's structure. They cannot
  // be summarised and are never sent; they come back bullet-less, in place.
  const sendable = sections.filter((section) => section.text.trim().length > 0);
  if (sendable.length === 0) {
    throw new ProviderError("This document has no section text to summarise.", {
      kind: "malformed",
      providerId,
    });
  }

  const chain = [providerId, ...fallbacksFor(providerId)];
  const tried = [];
  let lastError;

  for (const id of chain) {
    tried.push(id);
    if (tried.length > 1) onProviderChange?.(id);
    try {
      const result = await run({ id, sendable, resolveKey, meta, onProgress, signal });
      return { ...result, sections: reinsertEmpty(sections, sendable, result.sections) };
    } catch (err) {
      if (!isFallbackWorthy(err)) throw err;
      lastError = err;
    }
  }

  // The chain is same-destination only. Reaching another destination — the local
  // model above all — is the reader's explicit choice, never a consequence of a
  // quota running out, so this stops and names the alternatives instead.
  throw new ProviderError(
    `${getProvider(tried.at(-1)).label} is rate limited and no other ` +
      `${getProvider(providerId).destination} provider is available.`,
    {
      kind: "exhausted",
      providerId: tried.at(-1),
      tried,
      otherDestinations: otherDestinationIds(providerId),
      cause: lastError,
    },
  );
}

function otherDestinationIds(providerId) {
  const { destination } = getProvider(providerId);
  return Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].destination !== destination);
}

async function run({ id, sendable, resolveKey, meta, onProgress, signal }) {
  const provider = getProvider(id);
  const apiKey = provider.keyRef ? await resolveKey(provider.keyRef) : null;

  // Totals across however many requests the strategy made — one under
  // whole-document, N + 1 under per-section. `requests` is what step 10's quota
  // counter needs; the token counts are the provider's own, not an estimate.
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  const call = async (messages, schema, onPartial) => {
    const result = await chatJson({ providerId: id, provider, apiKey, messages, schema, onPartial, signal });
    usage.requests++;
    usage.promptTokens += result.usage?.prompt_tokens ?? 0;
    usage.completionTokens += result.usage?.completion_tokens ?? 0;
    usage.totalTokens += result.usage?.total_tokens ?? 0;
    return result.data;
  };

  const produced =
    provider.strategy === "whole-document"
      ? await wholeDocument({ id, sendable, meta, call, onProgress })
      : await perSection({ id, sendable, meta, call, onProgress });

  return { ...produced, usage, providerId: id, model: provider.model, strategy: provider.strategy };
}

// One request carrying the whole paper: cheapest in tokens, one TL;DR written
// with the full text in context, and one request to account for.
async function wholeDocument({ id, sendable, meta, call, onProgress }) {
  const onPartial = onProgress
    ? (partials) => onProgress({ sections: partialSections(sendable, partials) })
    : undefined;

  const data = await call(
    wholeDocumentMessages(sendable, meta),
    outlineSchema(sendable.length),
    onPartial,
  );
  // Checksummed before it can become a cache entry: see align.js.
  return { sections: attachTargets(sendable, data.sections, id), tldr: data.tldr ?? "" };
}

// One request per section, bounded concurrency, each resolving independently so
// the pane fills as they land and one failure is one section, not the paper.
async function perSection({ id, sendable, meta, call, onProgress }) {
  const results = new Array(sendable.length);
  const failures = [];
  let next = 0;
  let stopped = null;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= sendable.length || stopped) return;
      try {
        const data = await call(sectionMessages(sendable[i], meta), outlineSchema(1, { tldr: false }));
        // One section in, one section out: the same checksum, one at a time.
        results[i] = attachTargets([sendable[i]], data.sections, id)[0];
      } catch (err) {
        // A malformed answer is this section's problem and the others still
        // stand. Anything else — a rate limit, a bad key, the network — would
        // fail the next request identically, so it stops the run and the caller
        // decides whether to fall back.
        if (!(err instanceof ProviderError) || err.kind !== "malformed") {
          stopped = err;
          throw err;
        }
        failures.push(err);
        results[i] = { ...target(sendable[i]), bullets: [], error: err.message };
      }
      onProgress?.({ sections: results.filter(Boolean) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sendable.length) }, worker));

  // Every section malformed is not a partial success; it is a broken provider,
  // and an outline of nothing must not be returned for caching.
  if (failures.length === sendable.length) throw failures[0];

  // No request in this strategy ever saw the whole paper, so the TL;DR is a
  // reduce over the bullets rather than over the text.
  const data = await call(tldrMessages(results, meta), tldrSchema);
  return { sections: results, tldr: data.tldr ?? "" };
}

const target = (section) => ({ title: section.title, page: section.page, y: section.y });

// Progressive fill: the model's echoed titles are not trusted for placement
// here either, but a partial response cannot be length-checked yet, so partials
// borrow the jump target of the section at that index and the finished response
// is what gets checksummed.
function partialSections(sendable, partials) {
  return partials.slice(0, sendable.length).map((partial, i) => ({
    ...target(sendable[i]),
    bullets: Array.isArray(partial.bullets) ? partial.bullets.filter((b) => typeof b === "string") : [],
  }));
}

// Empty-text sections return to their original index with no bullets, so the
// outline has the same shape as the paper.
function reinsertEmpty(all, sendable, summarised) {
  const bySentIndex = new Map(sendable.map((section, i) => [section, summarised[i]]));
  return all.map((section) => {
    const summary = bySentIndex.get(section);
    return summary ?? { ...target(section), bullets: [] };
  });
}
