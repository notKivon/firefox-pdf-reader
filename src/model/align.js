// Re-attaching each bullet's jump target, and proving it belongs there.
//
// CLAUDE.md: `page`/`y` come from the extracted section at that index, never
// from the model; the model echoes each `title` and the echo is compared as a
// checksum. A section dropped, added or retitled shifts every later bullet onto
// the wrong heading, and the result would be cached and served afterwards with
// no network request and no confirmation — so a mismatch is a malformed
// response, surfaced as an error, never a best-effort render.
import { ProviderError } from "./errors.js";

// Compared leniently enough to survive a model normalising whitespace or case,
// strictly enough that a different heading cannot pass: the words must match.
export function normaliseTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,]+$/, "");
}

/**
 * @param {{title: string, page: number, y: number}[]} sent sections as extracted
 * @param {{title: string, bullets: string[]}[]} returned the model's echo
 * @param {string} providerId for the error
 * @returns {{title, page, y, bullets}[]} sent order, jump targets from `sent`
 */
export function attachTargets(sent, returned, providerId) {
  if (!Array.isArray(returned)) {
    throw new ProviderError("The model's response had no sections array.", {
      kind: "malformed",
      providerId,
    });
  }
  if (returned.length !== sent.length) {
    throw new ProviderError(
      `The model returned ${returned.length} sections for ${sent.length} sent. ` +
        "Bullets could not be matched to the paper, so nothing was saved.",
      { kind: "malformed", providerId },
    );
  }

  return sent.map((section, i) => {
    const echoed = returned[i];
    if (normaliseTitle(echoed?.title) !== normaliseTitle(section.title)) {
      throw new ProviderError(
        `Section ${i + 1} came back as "${echoed?.title ?? ""}" but was sent as ` +
          `"${section.title}". Bullets could not be matched to the paper, so nothing was saved.`,
        { kind: "malformed", providerId },
      );
    }
    return {
      title: section.title,
      page: section.page,
      y: section.y,
      bullets: cleanBullets(echoed.bullets, providerId, i),
    };
  });
}

function cleanBullets(bullets, providerId, index) {
  if (!Array.isArray(bullets) || bullets.some((b) => typeof b !== "string")) {
    throw new ProviderError(`Section ${index + 1} came back without a list of bullets.`, {
      kind: "malformed",
      providerId,
    });
  }
  // Bullet COUNT is not enforced here. The schema pins it where the provider
  // honours minItems/maxItems, and where it does not, an outline with one bullet
  // on a section is still worth reading — unlike a misaligned one, which is not.
  // PROGRESS.md records what the providers actually enforce.
  return bullets.map((b) => b.trim()).filter(Boolean);
}
