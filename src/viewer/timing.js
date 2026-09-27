// One console line per opened paper saying where the time went, so the capture
// path and the fetch fallback can be compared on a real connection rather than
// argued about. All stamps are epoch ms; the line shows gaps between them.
const STEPS = [
  ["headers", "complete", "download"],
  ["complete", "stashed", "hand-off"],
  ["stashed", "viewerStart", "viewer boot"],
  ["viewerStart", "bytesInHand", "bytes in hand"],
  ["bytesInHand", "loaded", "pdf.js load"],
];

/** @returns {string|null} the summary, or null for a local file */
export function timingLine(timing) {
  if (!timing) return null;
  const parts = STEPS.filter(([a, b]) => Number.isFinite(timing[a]) && Number.isFinite(timing[b])).map(
    ([a, b, label]) => `${label} ${timing[b] - timing[a]} ms`,
  );
  const start = timing.headers ?? timing.viewerStart;
  const total = Number.isFinite(start) && Number.isFinite(timing.loaded) ? ` · total ${timing.loaded - start} ms` : "";
  return `[scholar-reader] timing (${timing.path}): ${parts.join(" · ")}${total}`;
}

export function logTiming(source) {
  if (!source?.timing) return;
  source.timing.loaded = Date.now();
  console.info(timingLine(source.timing));
}
