// A real call to a real provider, to answer the questions no stub can.
//
// Run it by hand; it spends the user's API quota. It never writes the key
// anywhere and never prints it. Supply the key in a file OUTSIDE the repo:
//
//   mkdir -p ~/.config/scholar-reader
//   pbpaste > ~/.config/scholar-reader/gemini.key     # or an editor
//   chmod 600 ~/.config/scholar-reader/gemini.key
//   node tools/live-probe.mjs --fixture adam --provider gemini-dev
//
// What it measures, per SPEC.md's "Schema enforcement" and "Output quality":
//   - whether N sections in gives exactly N sections back;
//   - whether minItems/maxItems on `bullets` actually bind, probed directly by
//     asking the model for the wrong number and seeing what the decoder allows;
//   - bullets over 20 words, reported by position in the response, which is
//     where whole-document drift would show;
//   - whether Results-type sections keep their reported numbers.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { outline } from "../src/model/adapter.js";
import { getProvider } from "../src/model/providers.js";
import { MAX_BULLET_WORDS } from "../src/model/prompts.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

const fixtureName = args.get("fixture") ?? "adam";
const providerId = args.get("provider") ?? "gemini-dev";
const keyFile = process.env.SCHOLAR_READER_KEY_FILE ?? `${homedir()}/.config/scholar-reader/gemini.key`;

function loadKey() {
  try {
    const key = readFileSync(keyFile, "utf8").trim();
    if (!key) throw new Error("the file is empty");
    return key;
  } catch (err) {
    console.error(`No API key at ${keyFile} (${err.message}).\nSee the instructions at the top of this file.`);
    process.exit(2);
  }
}

const words = (bullet) => bullet.trim().split(/\s+/).length;
const NUMBER = /\d/;

function report(label, result, sent) {
  const provider = getProvider(result.providerId);
  const filled = result.sections.filter((s) => s.bullets.length > 0);
  const counts = filled.map((s) => s.bullets.length);
  const long = [];
  filled.forEach((section, position) => {
    for (const bullet of section.bullets) {
      if (words(bullet) > MAX_BULLET_WORDS) long.push({ position, words: words(bullet), title: section.title });
    }
  });
  const numeric = sent.filter((s) => /result|experiment|evaluation|analysis|ablation/i.test(s.title) && NUMBER.test(s.text));
  const keptNumbers = numeric.filter((s) => {
    const out = result.sections.find((r) => r.title === s.title);
    return out?.bullets.some((b) => NUMBER.test(b));
  });

  const failed = result.sections.filter((s) => s.error);
  const emptyInput = result.sections.filter((s) => !s.error && s.bullets.length === 0);

  console.log(`\n=== ${label} — ${provider.label} (${provider.strategy}) ===`);
  console.log(`sections in/out        ${sent.length} / ${result.sections.length}`);
  console.log(`sections with bullets  ${filled.length}`);
  console.log(`sections that failed   ${failed.length}` +
    (failed.length ? `  — ${failed.map((s) => `"${s.title}": ${s.error}`).join(" | ")}` : ""));
  console.log(`sections with no text  ${emptyInput.length} (never sent, correctly bullet-less)`);
  console.log(`bullets per section    min ${Math.min(...counts)}, max ${Math.max(...counts)}` +
    `  [${counts.join(" ")}]`);
  console.log(`outside 2-4            ${counts.filter((n) => n < 2 || n > 4).length}`);
  console.log(`bullets over ${MAX_BULLET_WORDS} words  ${long.length}` +
    (long.length ? `  at positions ${long.map((l) => l.position).join(", ")} of ${filled.length}` : ""));
  const lostNumbers = numeric.filter((s) => !keptNumbers.includes(s));
  console.log(`results sections keeping numbers  ${keptNumbers.length}/${numeric.length}` +
    (lostNumbers.length ? `  — lost by ${lostNumbers.map((s) => `"${s.title}"`).join(", ")}` : ""));
  console.log(`requests ${result.usage.requests}, tokens in ${result.usage.promptTokens}, out ${result.usage.completionTokens}`);
  console.log(`TL;DR: ${result.tldr}`);
  const sample = filled[0] ?? result.sections[0];
  console.log(`\nsample section — ${sample.title} (p${sample.page})`);
  for (const bullet of sample.bullets ?? []) console.log(`  • ${bullet} [${words(bullet)}w]`);
  if (long.length) {
    console.log(`\nlongest bullet: ${long.sort((a, b) => b.words - a.words)[0].words} words ` +
      `in "${long[0].title}"`);
  }
}

const apiKey = loadKey();
const resolveKey = async () => apiKey;
const { sections } = JSON.parse(readFileSync(new URL(`../fixtures/${fixtureName}.json`, import.meta.url), "utf8"));
const sendable = sections.filter((s) => s.text.trim());

console.log(`Sending ${fixtureName} (${sendable.length} sections, ${sendable.reduce((n, s) => n + s.text.length, 0)} chars) to ${providerId}…`);
const result = await outline({ sections, providerId, resolveKey, meta: { title: fixtureName } });
report(fixtureName, result, sendable);

// Schema-binding probe: the prompt asks for the wrong counts on purpose. If the
// decoder enforces minItems/maxItems the answer conforms anyway; if it does not,
// this is where it shows, and the adapter's own checks become the only guarantee.
console.log("\n=== schema-binding probe ===");
const probeSections = sendable.slice(0, 3);
const { chatJson } = await import("../src/model/openai-compat.js");
const { outlineSchema } = await import("../src/model/prompts.js");
try {
  const { data } = await chatJson({
    providerId,
    provider: getProvider(providerId),
    apiKey,
    schema: outlineSchema(probeSections.length),
    messages: [
      { role: "system", content: "Answer with JSON only." },
      {
        role: "user",
        content:
          `Summarise ONLY the first section of the ${probeSections.length} below — return exactly ONE ` +
          `section object, and give it exactly 7 bullets.\n\n` +
          probeSections.map((s, i) => `### Section ${i + 1}\nTitle: ${s.title}\n\n${s.text.slice(0, 2000)}`).join("\n\n"),
      },
    ],
  });
  const bullets = data.sections.map((s) => s.bullets.length);
  console.log(`asked for 1 section of 7 bullets, schema pins ${probeSections.length} sections / 2-4 bullets`);
  console.log(`got ${data.sections.length} sections, bullets [${bullets.join(" ")}]`);
  const sectionsBind = data.sections.length === probeSections.length;
  const bulletsBind = bullets.every((n) => n >= 2 && n <= 4);
  console.log(`minItems/maxItems on sections: ${sectionsBind ? "HONOURED" : "IGNORED"}`);
  console.log(`minItems/maxItems on bullets:  ${bulletsBind ? "HONOURED" : "IGNORED"}`);
} catch (err) {
  // A rejection is itself an answer: some strict decoders refuse the keywords.
  console.log(`probe rejected: ${err.kind ?? err.name} — ${err.message}`);
}
