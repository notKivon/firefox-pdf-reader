// PDF capture: the interceptor keeps the browser's own response instead of
// making the viewer fetch it again. What is pinned is what would fail with
// nothing on screen to say why: bytes altered on the way to the viewer, a
// script reaching the publisher-origin page, a tab left on the skeleton, a
// fallback that never falls back, and the skeleton's colours drifting from the
// reader it is standing in for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installIndexedDb } from "./idb.mjs";

installIndexedDb();
const store = {};
globalThis.browser = {
  storage: {
    local: { get: async (keys) => Object.fromEntries([keys].flat().map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o) },
    onChanged: { addListener() {} },
  },
  runtime: {
    getURL: (p) => `moz-extension://id/${p}`,
    onMessage: { addListener: (fn) => { routerListener = fn; } },
    // The viewer reaches the inbox only through the real router, as in Firefox.
    sendMessage: async (message) => routerListener(message, { tab: { id: 4 } }),
  },
};
let routerListener;

const { beginCapture, canCapture, rewriteHeaders, contentLength, SKELETON_CSP, MAX_CAPTURE_BYTES } = await import("../../src/background/capture.js");
const { skeletonHead, createProgress, openingRule, escapeHtml, TOKENS } = await import("../../src/background/skeleton.js");
const { stash, claim, sweep, INBOX_TTL_MS } = await import("../../src/store/inbox.js");
const { fromUrl, captureToken } = await import("../../src/viewer/source.js");
const { timingLine } = await import("../../src/viewer/timing.js");
const { registerRouter } = await import("../../src/background/router.js");
registerRouter({ bypass: { grant: () => true } });

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.stack}`); }
}

class FakeFilter {
  constructor() { this.written = []; this.closed = false; this.error = ""; }
  write(bytes) { if (this.closed) throw new Error("closed"); this.written.push(new TextDecoder().decode(bytes)); }
  close() { this.closed = true; }
  get page() { return this.written.join(""); }
}

const pdfHeaders = (extra = []) => [{ name: "Content-Type", value: "application/pdf" }, { name: "Content-Disposition", value: "attachment; filename=x.pdf" }, ...extra];
const details = (over = {}) => ({ url: "https://www.sciencedirect.com/pdfft?md5=abc&pid=1-s2.0-main.pdf", tabId: 4, requestId: "r1", type: "main_frame", statusCode: 200, responseHeaders: pdfHeaders([{ name: "Content-Length", value: "300" }]), ...over });

function run(d, { stashFn = stash } = {}) {
  const filter = new FakeFilter();
  const went = [];
  const out = beginCapture(d, {
    filterResponseData: () => filter,
    stash: stashFn,
    navigate: async (tabId, url) => went.push({ tabId, url }),
    viewerUrl: (url, token) => `moz-extension://id/viewer.html?file=${encodeURIComponent(url)}${token ? `&capture=${token}` : ""}`,
    name: "main.pdf",
    prefs: { theme: "dark", outlineWidth: 400 },
  });
  return { filter, went, out };
}

const bytesOf = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

await test("the captured bytes reach the viewer unaltered, and the tab moves there", async () => {
  const { filter, went, out } = run(details());
  const body = bytesOf(300);
  filter.onstart();
  for (let i = 0; i < 300; i += 100) filter.ondata({ data: body.slice(i, i + 100).buffer });
  await filter.onstop();
  assert.equal(went.length, 1);
  assert.equal(went[0].tabId, 4);
  const token = captureToken(new URL(went[0].url).search);
  assert.ok(token, "the viewer is told which capture is its own");
  const source = await fromUrl(details().url, token);
  assert.deepEqual(source.bytes, body);
  assert.equal(source.timing.path, "capture");
  const viewerSources = ["source.js", "viewer.js"].map((f) => readFileSync(new URL(`../../src/viewer/${f}`, import.meta.url), "utf8"));
  assert.ok(viewerSources.every((src) => !src.includes("store/inbox")), "the viewer never opens the inbox itself: a container tab's IndexedDB is a different partition");
  assert.ok(filter.closed);
  assert.ok(out.responseHeaders.some((h) => h.value === SKELETON_CSP));
});

await test("the page written into the publisher's origin holds no script and is sent under a no-script CSP", () => {
  const headers = rewriteHeaders(pdfHeaders([{ name: "Content-Security-Policy", value: "script-src 'unsafe-inline' *" }]));
  const names = headers.map((h) => h.name.toLowerCase());
  assert.ok(!names.includes("content-disposition"), "an attachment header would download the skeleton");
  assert.equal(names.filter((n) => n === "content-security-policy").length, 1, "the publisher's policy is replaced, not merged");
  assert.match(SKELETON_CSP, /default-src 'none'/);
  assert.doesNotMatch(SKELETON_CSP, /script-src/);
  assert.equal(headers.find((h) => h.name === "Content-Type").value, "text/html; charset=utf-8");
  const page = skeletonHead({ name: `<script>alert(1)</script>"x.pdf`, total: 10 }) + createProgress(10).update(5) + openingRule();
  assert.doesNotMatch(page, /<script|javascript:|\son\w+=/i);
  assert.ok(page.includes(escapeHtml("<script>")));
});

await test("progress is written a percent at a time, not once per network chunk", () => {
  const progress = createProgress(1000);
  const rules = [];
  for (let got = 1; got <= 1000; got++) { const r = progress.update(got); if (r) rules.push(r); }
  assert.equal(rules.length, 101);
  assert.match(rules.at(-1), /width:100%/);
  const unknown = createProgress(null);
  assert.doesNotMatch(unknown.update(300 * 1024), /width:\d/, "no length means no fill width, only a count");
  assert.doesNotMatch(skeletonHead({ name: "a", total: null }), /#bar i\{width:0\}/);
});

await test("a stash that fails still ends in the reader, which then fetches the URL itself", async () => {
  const { filter, went } = run(details(), { stashFn: async () => { throw new Error("quota"); } });
  filter.onstart();
  filter.ondata({ data: bytesOf(10).buffer });
  await filter.onstop();
  assert.equal(went.length, 1);
  assert.equal(captureToken(new URL(went[0].url).search), null);
});

await test("an empty body and an oversized one both fall back to the viewer's own fetch", async () => {
  const empty = run(details());
  empty.filter.onstart();
  await empty.filter.onstop();
  assert.equal(captureToken(new URL(empty.went[0].url).search), null);

  const big = run(details());
  big.filter.onstart();
  big.filter.ondata({ data: new ArrayBuffer(8) });
  big.filter.ondata({ data: { byteLength: MAX_CAPTURE_BYTES } });
  await big.filter.onstop();
  assert.equal(captureToken(new URL(big.went[0].url).search), null);
});

await test("a download cut short never moves the tab", async () => {
  const { filter, went } = run(details());
  filter.onstart();
  filter.ondata({ data: bytesOf(10).buffer });
  filter.error = "Channel redirected";
  filter.onerror();
  assert.equal(went.length, 0);
});

await test("only a whole, unencoded response in a real tab is captured", () => {
  assert.equal(canCapture(details(), true), true);
  assert.equal(canCapture(details(), false), false, "no StreamFilter");
  assert.equal(canCapture(details({ tabId: -1 }), true), false, "no tab to move");
  assert.equal(canCapture(details({ statusCode: 206 }), true), false, "a fragment of a PDF");
  assert.equal(canCapture(details({ responseHeaders: pdfHeaders([{ name: "Content-Encoding", value: "gzip" }]) }), true), false);
  assert.equal(canCapture(details({ responseHeaders: pdfHeaders([{ name: "Content-Encoding", value: "identity" }]) }), true), true);
  assert.equal(contentLength([{ name: "content-length", value: "abc" }]), null);
});

await test("a capture survives a reader reload, and expires after its TTL", async () => {
  let now = 1_000_000;
  const token = await stash({ url: "u", bytes: bytesOf(4) }, () => now);
  assert.ok(await claim(token, () => now));
  assert.ok(await claim(token, () => now), "reading does not consume it");
  now += INBOX_TTL_MS + 1;
  assert.equal(await claim(token, () => now), null);
  assert.ok((await sweep(() => now)) >= 1);
  assert.equal(await claim(token, () => 1_000_000), null, "swept means gone");
});

await test("the skeleton's colours match theme.css in both themes", () => {
  const css = readFileSync(new URL("../../src/viewer/theme.css", import.meta.url), "utf8");
  const block = (selector) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
  const names = { bg: "--bg", bgRaised: "--bg-raised", bgSunken: "--bg-sunken", border: "--border", text: "--text", textDim: "--text-dim", accent: "--accent" };
  for (const [theme, selector] of [["dark", ":root"], ["light", ':root[data-theme="light"]']]) {
    const text = block(selector);
    for (const [key, prop] of Object.entries(names)) {
      const value = text.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1].trim();
      assert.equal(TOKENS[theme][key], value, `${theme} ${prop}`);
    }
  }
});

await test("the timing line reports each gap and the total", () => {
  const line = timingLine({ path: "capture", headers: 0, complete: 400, stashed: 410, viewerStart: 500, bytesInHand: 520, loaded: 700 });
  assert.match(line, /download 400 ms · hand-off 10 ms · viewer boot 90 ms · bytes in hand 20 ms · pdf\.js load 180 ms · total 700 ms/);
});

await test("the interceptor captures by default, still honours the bypass, and navigates even if loadReplace is refused", async () => {
  const { registerInterceptor } = await import("../../src/background/intercept.js");
  const { createBypass } = await import("../../src/background/bypass.js");
  let listener;
  const filters = [];
  const updates = [];
  browser.webRequest = {
    onHeadersReceived: { addListener: (fn) => { listener = fn; } },
    filterResponseData: () => { const f = new FakeFilter(); filters.push(f); return f; },
  };
  browser.tabs = {
    update: async (tabId, props) => {
      updates.push(props);
      if ("loadReplace" in props) throw new Error("Type error for parameter updateProperties (Unexpected property \"loadReplace\")");
    },
  };
  const bypass = createBypass();
  registerInterceptor({ bypass });
  await new Promise((r) => setTimeout(r, 0));

  const result = listener(details());
  assert.equal(result.redirectUrl, undefined, "no second request");
  assert.ok(result.responseHeaders);
  const [filter] = filters;
  filter.onstart();
  assert.match(filter.page, /Loading…/);
  filter.ondata({ data: bytesOf(300).buffer });
  await filter.onstop();
  assert.equal(updates.length, 2, "retried without loadReplace");
  assert.ok(captureToken(new URL(updates[1].url).search));

  assert.ok(listener(details({ statusCode: 206 })).redirectUrl, "a fragment falls back to the redirect");
  bypass.grant(4);
  assert.deepEqual(listener(details()), {}, "the escape hatch still wins");
  assert.equal(filters.length, 1);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
