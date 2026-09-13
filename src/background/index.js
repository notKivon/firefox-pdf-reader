// Background entry point. Wires the PDF interceptor, the message router, and
// the toolbar button.
import { createBypass } from "./bypass.js";
import { registerInterceptor } from "./intercept.js";
import { registerRouter } from "./router.js";

// Shared by the two halves of the escape hatch: the router grants a pass when
// the viewer asks, and the interceptor spends it.
const bypass = createBypass();

registerInterceptor({ bypass });
registerRouter({ bypass });

// A local PDF cannot be intercepted — Firefox only lets an extension redirect
// http(s) — so the toolbar button opens an empty viewer whose "Open local file"
// control is the way in (CLAUDE.md).
browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("viewer.html") }).catch((err) => {
    console.error("[scholar-reader] could not open the viewer", err);
  });
});

console.log("[scholar-reader] background loaded");
