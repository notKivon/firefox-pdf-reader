// Background entry point. Wires the PDF interceptor and the message router.
// The router arrives with the model adapter in step 7.
import { registerInterceptor } from "./intercept.js";

registerInterceptor();

console.log("[scholar-reader] background loaded");
