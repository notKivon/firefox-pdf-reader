// Where the viewer's PDF comes from: a URL the interceptor handed over, or a
// file the reader picked from this computer.
//
// Firefox only lets an extension redirect http(s) requests, so a `file://` PDF
// never reaches the interceptor. CLAUDE.md's answer is an explicit "Open local
// file" control rather than any attempt to read the filesystem: the reader picks
// the file, the page receives its bytes, and from there it is the same document
// as any other — identity is the sha256 of those bytes, so a paper opened
// locally shares its cache, its consent and its reading position with the same
// paper fetched from arXiv.
// Anything past this is almost certainly not a paper, and reading it whole into
// memory to find that out would hang the tab first.
export const MAX_LOCAL_BYTES = 512 * 1024 * 1024;

/** @returns {string|null} the interceptor's `?file=` URL, when there is one */
export function requestedUrl(search = window.location.search) {
  const file = new URLSearchParams(search).get("file");
  return file && file.trim() ? file : null;
}

/**
 * Only http(s) documents can be reopened in the browser's own viewer: that is
 * a navigation, and a local file's bytes have no URL to navigate to.
 */
export function isWebUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchPdf(url) {
  const host = new URL(url).host;
  let response;
  try {
    // Extension pages inherit host_permissions, so this cross-origin fetch is
    // not subject to CORS. Cookies go along for paywalled publisher PDFs.
    response = await fetch(url, { credentials: "include" });
  } catch (cause) {
    throw new Error(`Could not reach ${host}. The PDF was not downloaded.`, { cause });
  }
  if (!response.ok) {
    throw new Error(`${host} returned HTTP ${response.status} for this PDF.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {string} url
 * @returns {Promise<{bytes: Uint8Array, name: string, url: string, local: false}>}
 */
export async function fromUrl(url) {
  return { bytes: await fetchPdf(url), name: nameOf(url), url, local: false };
}

/**
 * @param {File} file
 * @returns {Promise<{bytes: Uint8Array, name: string, url: string, local: true}>}
 */
export async function fromFile(file) {
  if (!file) throw new Error("No file was chosen.");
  if (file.size > MAX_LOCAL_BYTES) {
    throw new Error(`${file.name} is ${Math.round(file.size / 1024 / 1024)} MB, which is too large to open here.`);
  }
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (cause) {
    throw new Error(`${file.name} could not be read from disk.`, { cause });
  }
  // Recorded under a `local:` pseudo-URL. The real path is not available to a
  // web page and would be meaningless on another machine; the name is what the
  // reader will recognise in the document's list of places it came from.
  return { bytes: new Uint8Array(buffer), name: file.name, url: `local:${file.name}`, local: true };
}

/**
 * Resolves with the first file the reader picks, from whichever control they
 * use. The input's value is cleared so picking the same file again still fires.
 *
 * @param {HTMLInputElement} input the hidden `type=file` input
 * @param {HTMLElement[]} triggers buttons that open the picker
 * @returns {Promise<File>}
 */
export function nextPickedFile(input, triggers) {
  return new Promise((resolve) => {
    const open = () => input.click();
    for (const trigger of triggers) trigger.addEventListener("click", open);
    input.addEventListener("change", function onChange() {
      const [file] = input.files ?? [];
      input.value = "";
      if (!file) return;
      input.removeEventListener("change", onChange);
      for (const trigger of triggers) trigger.removeEventListener("click", open);
      resolve(file);
    });
  });
}

export function nameOf(url) {
  try {
    const { pathname, host } = new URL(url);
    const last = pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : host;
  } catch {
    return url;
  }
}
