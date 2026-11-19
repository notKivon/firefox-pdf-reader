// Sending the PDF itself (2026-11-19, at the user's request).
//
// The model reads the rendered pages: columns in order, superscripts as
// superscripts, equations and figures as printed, running heads recognisable as
// page furniture. The extracted text layer stays on this machine for what only
// it can do — placing sections and bullets on the page.
//
// One wire shape for every provider that takes it: an OpenAI-style image_url
// part carrying a `data:application/pdf` URL. Gemini's OpenAI-compatible
// endpoint accepts exactly that (its `file` part type is refused), and the
// bridge turns it into a Claude document block.

// The providers' own ceilings, with room to spare: Claude takes 32 MB and 100
// pages per document. Past either, the extracted text goes instead.
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;

/** @param {{data?: Uint8Array, size?: number, pages?: number}|null} pdf */
export function pdfFits(pdf) {
  const size = pdf?.data?.byteLength ?? pdf?.size ?? 0;
  return size > 0 && size <= MAX_PDF_BYTES && (pdf.pages ?? 0) > 0 && pdf.pages <= MAX_PDF_PAGES;
}

/** Whether this provider is sent the PDF rather than the extracted text. */
export const sendsPdf = (provider, pdf) => provider?.pdf === true && pdfFits(pdf);

// Rough input tokens per page, read off real calls on 2026-11-19: a 7-page
// IEEE paper cost Claude ~24k tokens and Gemini ~12k. Only for the card's
// estimate, which says "est.".
export const pdfTokens = (provider, pages) => Math.round((provider?.pdfTokensPerPage ?? 3_400) * pages);

/** @param {Uint8Array} bytes */
export function pdfPart(bytes) {
  return { type: "image_url", image_url: { url: `data:application/pdf;base64,${toBase64(bytes)}` } };
}

// btoa takes a binary string; built in slices so a 30 MB file does not need
// one 30-million-argument call.
function toBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
