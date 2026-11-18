// Text statistics shared by the text layer and column layout, kept free of
// pdf.js so column layout can be tested in Node.

// Height bucket for the modal-height statistic. Fine enough to tell 10pt body
// text from an 11pt heading, coarse enough that rounding noise doesn't split
// one font size across two buckets.
const HEIGHT_BUCKET = 0.1;

// The most common item height, which for an academic paper is the body font.
// Deliberately a plain mode over items, as specified — not weighted by
// character count — so that step 6's body-size rule and this one agree.
export function modalHeight(items) {
  const counts = new Map();
  let best = 0;
  let bestCount = 0;
  for (const item of items) {
    if (!item.height) continue;
    const bucket = Math.round(item.height / HEIGHT_BUCKET) * HEIGHT_BUCKET;
    const count = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, count);
    if (count > bestCount || (count === bestCount && bucket < best)) {
      best = bucket;
      bestCount = count;
    }
  }
  return best;
}

