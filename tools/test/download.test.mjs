// Saving the PDF: what the file is called, and that the bytes come from pdf.js
// rather than from a second request.
import assert from "node:assert/strict";

const { downloadName, initDownload } = await import("../../src/viewer/download.js");

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

await test("the title names the file, with exactly one .pdf", async () => {
  assert.equal(downloadName("Attention Is All You Need", "https://arxiv.org/pdf/1706.03762"), "Attention Is All You Need.pdf");
  assert.equal(downloadName("paper.PDF", undefined), "paper.pdf");
});

await test("characters a filesystem refuses become spaces, and runs collapse", async () => {
  assert.equal(downloadName('A/B: "C" <D>?', ""), "A B C D.pdf");
  assert.equal(downloadName("line\none\ttwo", ""), "line one two.pdf");
});

await test("no title falls back to the URL's last segment, then to 'paper'", async () => {
  assert.equal(downloadName("", "https://arxiv.org/pdf/1706.03762v7"), "1706.03762v7.pdf");
  assert.equal(downloadName("  ", "https://example.org/"), "paper.pdf");
  assert.equal(downloadName(undefined, "not a url"), "paper.pdf");
  assert.equal(downloadName("...", ""), "paper.pdf");
});

await test("a very long title is cut, not passed to the filesystem whole", async () => {
  const name = downloadName("x".repeat(400), "");
  assert.ok(name.length <= 124, `length ${name.length}`);
  assert.ok(name.endsWith(".pdf"));
});

// Just enough DOM for the click path.
function rig({ getData }) {
  const listeners = {};
  const button = {
    hidden: true, disabled: false,
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const clicked = [];
  const doc = {
    body: { append() {} },
    createElement: () => ({ click() { clicked.push({ href: this.href, download: this.download }); }, remove() {} }),
  };
  const notes = [];
  const ctl = initDownload({ button, onNote: (t) => notes.push(t), doc });
  return { button, clicked, notes, ctl, click: () => listeners.click(), pdfDoc: { getData } };
}

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};

await test("the button stays hidden until a document is open, and then saves its bytes", async () => {
  let calls = 0;
  const r = rig({ getData: async () => { calls++; return new Uint8Array([37, 80, 68, 70]); } });
  assert.equal(r.button.hidden, true);
  await r.click();
  assert.equal(calls, 0, "nothing to save before a document");
  r.ctl.setDocument(r.pdfDoc, { title: "local.pdf", url: "local:local.pdf" });
  assert.equal(r.button.hidden, false);
  r.ctl.setTitle("A Stored Title");
  await r.click();
  assert.equal(calls, 1);
  assert.deepEqual(r.clicked, [{ href: "blob:test", download: "A Stored Title.pdf" }]);
  assert.equal(r.button.disabled, false, "re-enabled afterwards");
});

await test("a failure is said beside the outline, and the button comes back", async () => {
  const r = rig({ getData: async () => { throw new Error("worker gone"); } });
  r.ctl.setDocument(r.pdfDoc, { title: "t", url: "https://x.org/a.pdf" });
  await r.click();
  assert.deepEqual(r.notes, ["The PDF could not be saved: worker gone"]);
  assert.equal(r.button.disabled, false);
});

URL.createObjectURL = realCreate;
URL.revokeObjectURL = realRevoke;

console.log(results.join("\n"));
console.log(`\ndownload: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
