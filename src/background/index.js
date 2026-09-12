// Background entry point. Wires the PDF interceptor and the message router.
import { registerInterceptor } from "./intercept.js";
import { registerRouter } from "./router.js";

registerInterceptor();
registerRouter();

console.log("[scholar-reader] background loaded");
