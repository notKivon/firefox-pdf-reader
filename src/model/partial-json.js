// Progressive fill under `whole-document`: one response carries every section,
// so the pane can only fill as it arrives if complete objects can be pulled out
// of a half-written JSON document.
//
// Deliberately a scanner, not a parser: it finds objects inside `"sections": [`
// that have already closed, and ignores the unfinished tail. The finished
// response is still parsed and checksummed in full before anything is cached —
// a partially rendered pane is never a cached one (SPEC.md).

const SECTIONS_KEY = /"sections"\s*:\s*\[/;

/**
 * @param {string} text the response content accumulated so far
 * @returns {object[]} the objects in `sections[]` that are complete, parsed
 */
export function completeSections(text) {
  const start = text.match(SECTIONS_KEY);
  if (!start) return [];
  let i = start.index + start[0].length;

  const out = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        const parsed = tryParse(text.slice(objectStart, i + 1));
        if (parsed) out.push(parsed);
        objectStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      // End of sections[]; anything after belongs to tldr.
      break;
    }
  }
  return out;
}

function tryParse(fragment) {
  try {
    return JSON.parse(fragment);
  } catch {
    // A closed brace that is not valid JSON on its own means the scan lost its
    // place; dropping the fragment is right, the full parse still has to pass.
    return null;
  }
}
