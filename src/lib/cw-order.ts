import { readResumeEntry } from "@/lib/resume";
import { resolvedEpisodeCoords, type LibraryItem } from "@/lib/stremio";

/** Parse a stored timestamp that may arrive as an ISO string or epoch millis. */
function parseStamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Imported resume entries record the fetch time, not the playback time, so they must not drive Continue Watching order. Only locally
 * played resume entries carry a real playback timestamp.
 */
function localResumeAt(item: LibraryItem): number | null {
  const coords = resolvedEpisodeCoords(item);
  const entry = readResumeEntry(item._id, coords?.season, coords?.episode);
  if (!entry || entry.source) return null;
  return parseStamp(entry.t);
}

/**
 * The real playback time of a Continue Watching card.
 *
 * A deduped card can carry several source checkpoints; the newest one is the
 * card's activity. A local resume entry is a fallback only when no checkpoint
 * carries a timestamp, and `_mtime` is used only when there is no playback
 * evidence at all — library maintenance also moves `_mtime`.
 */
export function cwPlaybackAt(item: LibraryItem): number {
  let best: number | null = parseStamp(item.state?.lastWatched);
  for (const member of item.cwMembers ?? []) {
    const at = parseStamp(member.state?.lastWatched);
    if (at != null && (best == null || at > best)) best = at;
  }
  if (best == null) best = localResumeAt(item);
  if (best == null) best = parseStamp(item._mtime);
  return best ?? 0;
}

/** Stable descending order by genuine playback recency. */
export function sortCwFinal<T extends LibraryItem>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, at: cwPlaybackAt(item) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.item);
}
