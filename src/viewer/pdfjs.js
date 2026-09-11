// Ordering shim for the two pdf.js bundles.
//
// `web/pdf_viewer.mjs` destructures `globalThis.pdfjsLib` at module-evaluation
// time; `build/pdf.mjs` assigns that global as a side effect of evaluating.
// Importing the core first *here* fixes the order inside the esbuild bundle —
// importing the viewer directly from a consumer would not guarantee it.
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";

export * from "pdfjs-dist/web/pdf_viewer.mjs";
export { pdfjsLib };
