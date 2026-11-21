import { CW_FINISHED_RATIO, type LibraryItem } from "./stremio";
import type { LocalEntry } from "./watchlist";
import { isMovieWatchedLocal } from "./movie-watched";
import { isWatchedFlagged } from "./watched-flag";

function movieProgress(item: LibraryItem): number {
  const duration = item.state?.duration ?? 0;
  const offset = item.state?.timeOffset ?? 0;
  return duration > 0 ? Math.min(1, offset / duration) : 0;
}

/**
 * A movie is finished when its watched flag is set or it passed the player's
 * completion threshold. Series are resolved lazily against their released
 * episode list; Stremio's timesWatched increments per episode, not per show.
 */
export function isStremioMovieFinished(item: LibraryItem | null | undefined): boolean {
  if (!item || item.type !== "movie") return false;
  return (
    (item.state?.flaggedWatched ?? 0) > 0 ||
    (item.state?.timesWatched ?? 0) > 0 ||
    movieProgress(item) >= CW_FINISHED_RATIO
  );
}

/** Collect every id a finished Stremio movie can be recognised by. */
export function collectStremioFinishedIds(items: LibraryItem[]): Set<string> {
  const finished = new Set<string>();
  for (const item of items) {
    if (!isStremioMovieFinished(item)) continue;
    finished.add(item._id);
    for (const id of item.altIds ?? []) finished.add(id);
  }
  return finished;
}

/**
 * A merged Watchlist card is finished when its movie watched state says so, or
 * a series was explicitly flagged watched / verified by the lazy released-
 * episode check. Library keeps finished cards; only the Watchlist view filters.
 */
export function isMergedWatchlistCardFinished(
  card: { meta: { id: string; type: string }; stremioId?: string; localId?: string },
  locals: LocalEntry[],
  stremioFinishedIds: ReadonlySet<string>,
  finishedSeries: ReadonlySet<string>,
): boolean {
  const local = card.localId ? locals.find((entry) => entry.id === card.localId) : undefined;
  const ids = new Set<string>();
  ids.add(card.meta.id);
  if (card.stremioId) ids.add(card.stremioId);
  if (card.localId) ids.add(card.localId);
  if (local?.imdbId) ids.add(local.imdbId);

  for (const id of ids) {
    if (finishedSeries.has(id)) return true;
    if (isWatchedFlagged(id)) return true;
  }
  if (card.meta.type === "movie") {
    for (const id of ids) {
      if (stremioFinishedIds.has(id)) return true;
      if (isMovieWatchedLocal(id, [...ids])) return true;
    }
  }
  return false;
}
