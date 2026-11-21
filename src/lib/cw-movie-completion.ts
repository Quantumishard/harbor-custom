import { cwTitleKey, movieIdentityIds } from "@/lib/cw-anime-identity";
import { CW_FINISHED_RATIO, type LibraryItem } from "@/lib/stremio";

/**
 * Keep completed movie checkpoints in the reconciliation pool until AFTER
 * checking older, incomplete checkpoints. The old pipeline called isCwMember
 * first, losing the completed record before alias dedupe could see it.
 *
 * This is display eligibility only. We never mutate or delete library/resume
 * records; a genuine later rewatch remains eligible.
 */
const MOVIE = /^(?:tt[1-9]\d*|tmdb:movie:[1-9]\d*)$/;

function movie(row: LibraryItem): boolean {
  return row.type === "movie" && !row.isAnime && MOVIE.test(row._id);
}

export function isCompletedMovieCheckpoint(row: LibraryItem): boolean {
  if (!movie(row) || (row.removed && !row.temp)) return false;
  if (row.upNext || row.caughtUp || row.waitingForAir) return false;
  const state = row.state;
  if (!state) return false;
  return (state.flaggedWatched ?? 0) > 0 ||
    ((state.duration ?? 0) > 0 &&
      (state.timeOffset ?? 0) / state.duration >= CW_FINISHED_RATIO);
}

function stamp(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (typeof raw !== "string") return 0;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

function playbackAt(row: LibraryItem): number {
  // Prefer actual playback timestamps. _mtime is only a fallback for older
  // Stremio records that have no lastWatched; it may reflect library updates.
  return stamp(row.state?.lastWatched) || stamp(row._mtime);
}

type MovieAliasIds = (item: LibraryItem) => string[];
type MovieReconciliation<T> = {
  rows: T[];
  suppressed: T[];
  /** Completed rows retained as suppression evidence (but not displayed). */
  completions: T[];
};

export function reconcileCompletedMovies<T extends LibraryItem>(
  rows: readonly T[],
  aliases: MovieAliasIds = movieIdentityIds,
): MovieReconciliation<T> {
  const completions = rows.filter(isCompletedMovieCheckpoint);
  if (!completions.length) return { rows: [...rows], suppressed: [], completions: [] };

  const parent = new Map<string, string>();
  function root(id: string): string {
    const prev = parent.get(id);
    if (!prev) { parent.set(id, id); return id; }
    if (prev === id) return id;
    const result = root(prev);
    parent.set(id, result);
    return result;
  }
  function join(a: string, b: string) {
    const first = root(a);
    const second = root(b);
    if (first !== second) parent.set(second, first);
  }

  // Exact IDs and confirmed IMDb/TMDB aliases only. Names never prove identity.
  for (const row of rows) {
    if (!movie(row)) continue;
    const ids = [...new Set(aliases(row).filter((id) => MOVIE.test(id)))];
    for (const id of ids.slice(1)) join(ids[0], id);
    root(row._id);
  }
  const imdbByGroup = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    if (!id.startsWith("tt")) continue;
    const key = root(id);
    const group = imdbByGroup.get(key) ?? new Set<string>();
    group.add(id);
    imdbByGroup.set(key, group);
  }
  const completedAt = new Map<string, number>();
  for (const row of completions) {
    const key = root(row._id);
    // Conflicting IMDb aliases make a group unsafe; fail open, do not hide.
    if ((imdbByGroup.get(key)?.size ?? 0) > 1) continue;
    const time = playbackAt(row);
    if (time <= 0) continue;
    completedAt.set(key, Math.max(completedAt.get(key) ?? 0, time));
  }

  const suppressed: T[] = [];
  const visible = rows.filter((row) => {
    if (!movie(row) || isCompletedMovieCheckpoint(row)) return true;
    const key = root(row._id);
    if ((imdbByGroup.get(key)?.size ?? 0) > 1) return true;
    const completedTime = completedAt.get(key);
    const progressTime = playbackAt(row);
    if (completedTime == null || progressTime <= 0 || progressTime > completedTime) return true;
    suppressed.push(row);
    return false;
  });
  return { rows: visible, suppressed, completions };
}

/**
 * A matching title is a cheap HINT for warming the verified movie mapping,
 * never an identity assertion. Without a potential completed/incomplete pair,
 * don't look up unrelated movies in a large library.
 */
export function movieCompletionAliasWarmRows(rows: readonly LibraryItem[]): LibraryItem[] {
  const completedTitles = new Set(rows.filter(isCompletedMovieCheckpoint).map(cwTitleKey).filter(Boolean));
  if (completedTitles.size === 0) return [];
  const candidates = rows.filter((row) =>
    movie(row) && completedTitles.has(cwTitleKey(row)));
  return candidates.some((row) => !isCompletedMovieCheckpoint(row)) ? candidates : [];
}
