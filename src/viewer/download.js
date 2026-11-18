// "Save PDF": hands the reader the exact bytes on screen as a file.
//
// The bytes come from pdf.js (`getData()`), not from the source: the buffer the
// viewer fetched may have been transferred to pdf.js's worker and left detached.
// They are never fetched again — for a single-use publisher link (the reason the
// capture path exists) a second request is exactly the one that is refused.
//
// A blob link with `download` rather than `browser.downloads`: it needs no new
// permission, so the signed manifest's permission list stays as it is.

// Characters no common filesystem accepts in a name, plus control characters.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const MAX_STEM = 120;

/**
 * A filename for the paper: its title when it has one worth using, else the
 * last segment of its URL, always ending in exactly one `.pdf`.
 *
 * @param {string | undefined} title
 * @param {string | undefined} url
 */
export function downloadName(title, url) {
  const fromUrl = (() => {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop();
      return last ? decodeURIComponent(last) : "";
    } catch {
      return "";
    }
  })();
  const raw = (title && title.trim()) || fromUrl || "paper";
  let stem = raw
    .replace(/\.pdf$/i, "")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).trimEnd();
  return `${stem || "paper"}.pdf`;
}

/**
 * @param {object} args
 * @param {HTMLButtonElement} args.button
 * @param {(text: string) => void} args.onNote
 * @param {Document} [args.doc]
 */
export function initDownload({ button, onNote, doc = globalThis.document }) {
  let pdfDoc = null;
  let title = "";
  let url = "";
  let busy = false;

  button.addEventListener("click", async () => {
    if (!pdfDoc || busy) return;
    busy = true;
    button.disabled = true;
    try {
      const data = await pdfDoc.getData();
      const href = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
      const link = doc.createElement("a");
      link.href = href;
      link.download = downloadName(title, url);
      link.hidden = true;
      doc.body.append(link);
      link.click();
      link.remove();
      // The download has its own copy once started; a minute is ample margin.
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch (err) {
      onNote(`The PDF could not be saved: ${err?.message ?? err}`);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  return {
    /** Called once pdf.js has the document. */
    setDocument(next, { title: nextTitle, url: nextUrl }) {
      pdfDoc = next;
      title = nextTitle;
      url = nextUrl?.startsWith("local:") ? "" : nextUrl;
      button.hidden = false;
    },
    /** The stored title can arrive after the document; it names the file. */
    setTitle(nextTitle) {
      if (nextTitle) title = nextTitle;
    },
  };
}
