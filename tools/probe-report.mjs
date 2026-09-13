// Output-quality measurements shared by `live-probe.mjs` and `prod-check.mjs`.
//
// SPEC.md's "Output quality under whole-document": bullets outside 2–4, bullets
// over 20 words AS A FUNCTION OF POSITION in the response (the long-tail drift a
// schema cannot prevent), and whether Results sections keep their numbers.
import { getProvider } from "../src/model/providers.js";
import { MAX_BULLET_WORDS } from "../src/model/prompts.js";

export const words = (bullet) => bullet.trim().split(/\s+/).length;
const NUMBER = /\d/;
const RESULTS = /result|experiment|evaluation|analysis|ablation/i;

/** The numbers, without printing — so a run over many fixtures can total them. */
export function measure(result, sent) {
  const filled = result.sections.filter((s) => s.bullets.length > 0);
  const counts = filled.map((s) => s.bullets.length);
  const long = [];
  filled.forEach((section, position) => {
    for (const bullet of section.bullets) {
      if (words(bullet) > MAX_BULLET_WORDS) long.push({ position, words: words(bullet), title: section.title });
    }
  });
  const numeric = sent.filter((s) => RESULTS.test(s.title) && NUMBER.test(s.text));
  const keptNumbers = numeric.filter((s) =>
    result.sections.find((r) => r.title === s.title)?.bullets.some((b) => NUMBER.test(b)),
  );
  // Position drift: over-length bullets per third of the response. A
  // whole-document answer that degrades late shows it in the last third.
  const thirds = [0, 0, 0];
  const bulletsPerThird = [0, 0, 0];
  filled.forEach((section, position) => {
    const third = Math.min(2, Math.floor((position * 3) / filled.length));
    bulletsPerThird[third] += section.bullets.length;
  });
  for (const l of long) thirds[Math.min(2, Math.floor((l.position * 3) / filled.length))]++;
  const tldrSentences = (result.tldr.match(/[.!?](\s|$)/g) ?? []).length;

  return {
    sent: sent.length,
    returned: result.sections.length,
    filled,
    counts,
    outside: counts.filter((n) => n < 2 || n > 4).length,
    bullets: counts.reduce((a, b) => a + b, 0),
    long,
    thirds,
    bulletsPerThird,
    numeric,
    keptNumbers,
    failed: result.sections.filter((s) => s.error),
    emptyInput: result.sections.filter((s) => !s.error && s.bullets.length === 0),
    tldrSentences,
  };
}

export function report(label, result, sent) {
  const provider = getProvider(result.providerId);
  const m = measure(result, sent);
  const lostNumbers = m.numeric.filter((s) => !m.keptNumbers.includes(s));

  console.log(`\n=== ${label} — ${provider.label} (${provider.strategy}) ===`);
  console.log(`sections in/out        ${m.sent} / ${m.returned}`);
  console.log(`sections with bullets  ${m.filled.length}`);
  console.log(`sections that failed   ${m.failed.length}` +
    (m.failed.length ? `  — ${m.failed.map((s) => `"${s.title}": ${s.error}`).join(" | ")}` : ""));
  console.log(`sections with no text  ${m.emptyInput.length} (never sent, correctly bullet-less)`);
  console.log(`bullets per section    min ${Math.min(...m.counts)}, max ${Math.max(...m.counts)}` +
    `  [${m.counts.join(" ")}]`);
  console.log(`outside 2-4            ${m.outside}`);
  console.log(`bullets over ${MAX_BULLET_WORDS} words  ${m.long.length}` +
    (m.long.length ? `  at positions ${m.long.map((l) => l.position).join(", ")} of ${m.filled.length}` : ""));
  console.log(`  by third of response ${m.thirds.join(" / ")}  (of ${m.bulletsPerThird.join(" / ")} bullets)`);
  console.log(`results sections keeping numbers  ${m.keptNumbers.length}/${m.numeric.length}` +
    (lostNumbers.length ? `  — lost by ${lostNumbers.map((s) => `"${s.title}"`).join(", ")}` : ""));
  console.log(`requests ${result.usage.requests}, tokens in ${result.usage.promptTokens}, out ${result.usage.completionTokens}`);
  console.log(`TL;DR (${m.tldrSentences} sentences): ${result.tldr}`);
  const sample = m.filled.at(-1) ?? result.sections.at(-1);
  console.log(`\nlast section — ${sample.title} (p${sample.page})`);
  for (const bullet of sample.bullets ?? []) console.log(`  • ${bullet} [${words(bullet)}w]`);
  if (m.long.length) {
    const longest = [...m.long].sort((a, b) => b.words - a.words)[0];
    console.log(`\nlongest bullet: ${longest.words} words in "${longest.title}"`);
  }
  return m;
}
