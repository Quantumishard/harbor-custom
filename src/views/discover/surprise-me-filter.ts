import type { Meta } from "@/lib/cinemeta";
import { shuffle } from "@/lib/feed/tags";
import { isTitleWatched } from "@/lib/watched-title";

const TILE_COUNT = 18;

export type SurpriseWatchedSources = {
  watchedFlags: Set<string>;
  movieWatched: Set<string>;
  externalWatched: Set<string>;
  stremioWatched: Set<string>;
};

export function filterSurprisePool(
  pool: Meta[],
  excludeWatched: boolean,
  sources: SurpriseWatchedSources,
): Meta[] {
  if (!excludeWatched) return pool;
  const remote = new Set([...sources.externalWatched, ...sources.stremioWatched]);
  return pool.filter(
    (meta) =>
      meta.type !== "movie" ||
      !isTitleWatched(meta, {
        watchedFlags: sources.watchedFlags,
        movieWatched: sources.movieWatched,
        stremioWatched: remote,
      }),
  );
}

export function reconcileSurpriseTiles(previous: Meta[], eligible: Meta[], seed?: number): Meta[] {
  const remaining = new Map(eligible.map((meta) => [meta.id, meta]));
  const next: Meta[] = [];
  for (const tile of previous) {
    const current = remaining.get(tile.id);
    if (!current) continue;
    next.push(current);
    remaining.delete(tile.id);
  }
  if (next.length < TILE_COUNT && remaining.size > 0) {
    next.push(...shuffle([...remaining.values()], seed).slice(0, TILE_COUNT - next.length));
  }
  return next.length === previous.length && next.every((tile, i) => tile === previous[i])
    ? previous
    : next;
}
