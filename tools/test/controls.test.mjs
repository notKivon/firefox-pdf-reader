// The reader's layout controls: typed page and zoom values, and the outline
// pane's width. The parts that can be wrong quietly are what a typed value turns
// into and what the field shows afterwards, so those are what is pinned here.
import assert from "node:assert/strict";

const { parsePage, parseZoom, formatZoom, createToolbarFields, MIN_ZOOM, MAX_ZOOM } = await import(
  "../../src/viewer/toolbar-fields.js"
);
const { clampWidth, MIN_OUTLINE, MIN_PDF } = await import("../../src/viewer/pane-resize.js");

let passed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`); }
}

// Just enough of an <input> for the field wiring.
class FakeInput {
  constructor() { this.value = ""; this.listeners = {}; this.textContent = ""; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, extra = {}) {
    let prevented = false;
    const event = { ...extra, preventDefault() { prevented = true; } };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return prevented;
  }
  focus() { globalThis.document.activeElement = this; this.fire("focus"); }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  select() {}
  setAttribute(name, value) { (this.attrs ??= {})[name] = String(value); }
  click() { this.fire("click"); }
}

function rig() {
  globalThis.document = { activeElement: null };
  const calls = [];
  const els = { pageInput: new FakeInput(), pageTotal: new FakeInput(), zoomInput: new FakeInput(), fitButton: new FakeInput() };
  const view = { goToPage: (n) => calls.push(["page", n]), zoomTo: (s) => calls.push(["zoom", s]) };
  const fields = createToolbarFields({ ...els, view });
  fields.setPage(3, 12);
  fields.setScale(1.25);
  return { ...els, fields, calls };
}

test("a page is a whole number, clamped into the document", () => {
  assert.equal(parsePage("7", 12), 7);
  assert.equal(parsePage(" 07 ", 12), 7);
  assert.equal(parsePage("0", 12), 1);
  assert.equal(parsePage("99", 12), 12);
  for (const bad of ["", "abc", "3.5", "-2", "2 3"]) assert.equal(parsePage(bad, 12), null, bad);
  assert.equal(parsePage("3", 0), null, "no document, no page");
});

test("a zoom is a percentage, with or without the sign, clamped", () => {
  assert.equal(parseZoom("150"), 1.5);
  assert.equal(parseZoom("150%"), 1.5);
  assert.equal(parseZoom(" 87.5 % "), 0.875);
  assert.equal(parseZoom("1"), MIN_ZOOM);
  assert.equal(parseZoom("5000"), MAX_ZOOM);
  for (const bad of ["", "0", "wide", "-50", "1.5x"]) assert.equal(parseZoom(bad), null, bad);
  assert.equal(formatZoom(1.25), "125%");
});

test("Enter on a typed page goes there and the field shows the live page", () => {
  const { pageInput, pageTotal, calls, fields } = rig();
  assert.equal(pageInput.value, "3");
  assert.equal(pageTotal.textContent, "/ 12");
  pageInput.focus();
  pageInput.value = "9";
  assert.equal(pageInput.fire("keydown", { key: "Enter" }), true);
  assert.deepEqual(calls, [["page", 9]]);
  assert.equal(document.activeElement, null, "Enter leaves the field");
  fields.setPage(9, 12);
  assert.equal(pageInput.value, "9");
});

test("a refused value or Escape puts the live value back and navigates nowhere", () => {
  const { pageInput, zoomInput, calls } = rig();
  pageInput.focus();
  pageInput.value = "nope";
  pageInput.fire("keydown", { key: "Enter" });
  assert.equal(pageInput.value, "3");
  zoomInput.focus();
  zoomInput.value = "300";
  zoomInput.fire("keydown", { key: "Escape" });
  assert.equal(zoomInput.value, "125%");
  assert.deepEqual(calls, []);
});

test("a typed zoom is applied as a scale", () => {
  const { zoomInput, calls } = rig();
  zoomInput.focus();
  zoomInput.value = "200%";
  zoomInput.fire("change");
  assert.deepEqual(calls, [["zoom", 2]]);
});

test("fit to width asks pdf.js for its preset, and stays lit only while it holds", () => {
  const { fitButton, fields, calls } = rig();
  assert.equal(fitButton.attrs["aria-pressed"], "false");
  fitButton.click();
  assert.deepEqual(calls, [["zoom", "page-width"]]);
  fields.setScale(1.37, "page-width");
  assert.equal(fitButton.attrs["aria-pressed"], "true");
  fields.setScale(1.5, undefined);
  assert.equal(fitButton.attrs["aria-pressed"], "false", "an explicit zoom releases it");
});

test("scrolling does not overwrite a page the reader is halfway through typing", () => {
  const { pageInput, fields } = rig();
  pageInput.focus();
  pageInput.value = "1";
  fields.setPage(4, 12);
  assert.equal(pageInput.value, "1");
  pageInput.blur();
  fields.setPage(5, 12);
  assert.equal(pageInput.value, "5");
});

test("the outline pane's width stays inside both minimums", () => {
  assert.equal(clampWidth(500, 1600), 500);
  assert.equal(clampWidth(100, 1600), MIN_OUTLINE);
  assert.equal(clampWidth(1500, 1600), 1600 - MIN_PDF, "the paper keeps its minimum");
  assert.equal(clampWidth(400, 500), MIN_OUTLINE, "too narrow for both: the outline's minimum wins");
  assert.equal(clampWidth(360.6, 1600), 361);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
