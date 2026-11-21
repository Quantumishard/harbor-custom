import type { KitsuSearchHit } from "@/lib/providers/kitsu";

function titleTokens(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3);
}

/**
 * The loaded franchise can end before newer cours (for example, JoJo's 2012
 * relations stop at Diamond is Unbreakable). Accept a Kitsu search result only
 * when the parent title, named arc, release year and format all agree.
 * A generic or ambiguous search must never assign the wrong tracker entry.
 */
export function matchingKitsuSeasonEntry(
  hits: readonly KitsuSearchHit[],
  seriesName: string,
  seasonName: string,
  year: string | undefined,
): string | null {
  const base = titleTokens(seriesName);
  const arc = titleTokens(seasonName);
  const releaseYear = Number(year);
  if (!base.length || !arc.length || !/^\d{4}$/.test(year ?? "")) return null;
  if (/^season\s*\d+$/i.test(seasonName.trim())) return null;

  // TVDB group years can be one calendar year later than an entry's Kitsu
  // premiere (a winter season released on streaming the preceding December).
  // Match the complete franchise + named arc and prefer the exact year; never
  // guess if more than one candidate remains.
  const candidates = hits.filter((hit) => {
    if (hit.year == null || Math.abs(hit.year - releaseYear) > 1 || !/^(tv|ona)$/i.test(hit.subtype ?? "")) return false;
    if (/\bpart\s+[2-9]\d*\b/i.test(hit.title) && !/\bpart\s+[2-9]\d*\b/i.test(seasonName)) return false;
    const words = new Set(titleTokens(hit.title));
    return base.every((word) => words.has(word)) && arc.every((word) => words.has(word));
  });
  const exact = candidates.filter((hit) => hit.year === releaseYear);
  if (exact.length > 1) return null;
  if (exact.length === 1) return `kitsu:${exact[0].id}`;
  return candidates.length === 1 ? `kitsu:${candidates[0].id}` : null;
}
