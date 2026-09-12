// What codepoints does pdf.js actually produce for a PDF?
//
//   node tools/probe-glyphs.mjs path/to/paper.pdf
//
// Makes the same call textlayer.js does (page.getTextContent()) and reports the
// raw result, before any normalising of ours. Written to settle a "the symbols
// do not render" report without the paper in hand: the three possible causes —
// a correct codepoint no font covers, a private-use codepoint pdf.js could not
// map, and a correct codepoint rendered badly — look identical on screen and
// need completely different fixes. Answers which one it is in one command.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";

const file = process.argv[2];
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false }).promise;
const counts = new Map();
const contexts = [];
const WANT = /[⊙∝-⨀-⫿○☉]/;

for (let n = 1; n <= Math.min(doc.numPages, 12); n++) {
  const page = await doc.getPage(n);
  const { items } = await page.getTextContent();
  for (const it of items) {
    if (!it.str) continue;
    for (const ch of it.str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) continue;
      counts.set(cp, (counts.get(cp) ?? 0) + 1);
    }
    if (WANT.test(it.str) && contexts.length < 8) contexts.push([n, it.str]);
  }
}
const pua = [...counts].filter(([cp]) => cp >= 0xE000 && cp <= 0xF8FF).sort((a,b)=>b[1]-a[1]);
console.log("pages scanned:", Math.min(doc.numPages, 12), "of", doc.numPages);
console.log("U+2299 ⊙ :", counts.get(0x2299) ?? 0);
console.log("U+2609 ☉ :", counts.get(0x2609) ?? 0, "(astronomical sun sign)");
console.log("U+221D ∝ :", counts.get(0x221D) ?? 0);
console.log("\nPRIVATE USE characters:", pua.length, "distinct");
for (const [cp,n] of pua.slice(0,15)) console.log(`   U+${cp.toString(16).toUpperCase()}  x${n}`);
console.log("\ncontexts:");
for (const [p,s] of contexts) console.log(`   p${p}: ${JSON.stringify(s.slice(0,60))}`);
const top = [...counts].sort((a,b)=>b[1]-a[1]).slice(0,12);
console.log("\ntop non-ASCII:");
for (const [cp,n] of top) console.log(`   U+${cp.toString(16).toUpperCase().padStart(4,"0")} ${String.fromCodePoint(cp)} x${n}`);
