import { simklRequest, SimklApiError } from "./client";
import { getSession } from "./session";
import { simklEntryIdKeys, simklEpisodeWatchKeys, simklLookupIds } from "./ids";
import type { SimklEpisodeCoords } from "./ids";
import { loadSimklProgress } from "./list-status";
import { isCwDismissed } from "@/lib/cw-dismiss";
import { readResumeEntry, saveResumeBatch } from "@/lib/resume";
import type { LibraryItem } from "@/lib/stremio";

type Ids = {
  imdb?: string;
  tmdb?: number | string;
  mal?: number;
  kitsu?: number;
  anilist?: number;
  anidb?: number;
};

type Node = { title?: string; year?: number; ids?: Ids };

type RawSession = {
  id?: number | string;
  progress?: number;
  paused_at?: string;
  watched_at?: string;
  movie?: Node;
  show?: Node;
  anime?: Node;
  episode?: {
    season?: number;
    number?: number;
    episode?: number;
    tvdb_season?: number;
    tvdb_number?: number;
  };
};

const DURATION_MS = { movie: 6_300_000, series: 2_640_000 };

function movieMetaId(ids?: Ids): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:movie:${ids.tmdb}`;
  return null;
}

function seriesMetaId(ids?: Ids): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:tv:${ids.tmdb}`;
  if (ids.mal) return `mal:${ids.mal}`;
  if (ids.kitsu) return `kitsu:${ids.kitsu}`;
  return null;
}

function buildItem(
  id: string,
  type: "movie" | "series",
  node: Node,
  pct: number,
  durMs: number,
  when: string,
  season?: number,
  episode?: number,
  isAnime?: boolean,
): LibraryItem {
  const hasEpisode =
    type === "series" && season != null && season > 0 && episode != null && episode > 0;
  return {
    _id: id,
    type,
    name: node.title ?? "Untitled",
    state: {
      timeOffset: Math.round((pct / 100) * durMs),
      duration: durMs,
      season: hasEpisode ? season : undefined,
      episode: hasEpisode ? episode : undefined,
      video_id: hasEpisode ? `${id}:${season}:${episode}` : undefined,
      lastWatched: when,
    },
    removed: false,
    temp: false,
    _ctime: when,
    _mtime: when,
    external: "simkl",
    isAnime,
  };
}

async function toLibraryItem(raw: RawSession): Promise<LibraryItem | null> {
  const pct = Math.min(100, Math.max(0, raw.progress ?? 0));
  if (pct < 1 || pct > 98) return null;
  const when = raw.paused_at ?? raw.watched_at ?? new Date(0).toISOString();

  if (raw.movie) {
    const id = movieMetaId(raw.movie.ids);
    return id ? buildItem(id, "movie", raw.movie, pct, DURATION_MS.movie, when) : null;
  }

  if (!raw.show && !raw.episode && raw.anime) {
    const movieId = movieMetaId(raw.anime.ids);
    if (movieId) {
      return buildItem(
        movieId,
        "movie",
        raw.anime,
        pct,
        DURATION_MS.movie,
        when,
        undefined,
        undefined,
        true,
      );
    }
  }

  const seriesNode = raw.show ?? raw.anime;
  if (seriesNode) {
    const anime = !!raw.anime && !raw.show;
    const ids = seriesNode.ids;
    const nativeId =
      anime &&
      (ids?.kitsu
        ? `kitsu:${ids.kitsu}`
        : ids?.mal
          ? `mal:${ids.mal}`
          : ids?.anilist
            ? `anilist:${ids.anilist}`
            : null);
    const mappedAnime = anime && !nativeId;
    const id = nativeId || seriesMetaId(ids);
    if (!id) return null;
    const season = mappedAnime
      ? raw.episode?.tvdb_season
      : (raw.episode?.season ?? (anime ? 1 : undefined));
    const episode = mappedAnime
      ? raw.episode?.tvdb_number
      : (raw.episode?.number ?? raw.episode?.episode);
    // Season-based anime IDs cannot be attached to franchise IDs without a mapping.
    if (mappedAnime && (season == null || episode == null)) return null;
    return buildItem(
      id,
      "series",
      seriesNode,
      pct,
      DURATION_MS.series,
      when,
      season,
      episode,
      anime,
    );
  }
  return null;
}

// The replayed stop exists to close a stuck "actively playing" session; a stop
// without one would only re-mark an item the user may have unmarked since the
// watch, so the pending replay gates it on this check.
export async function hasActiveSimklPlayback(
  metaId: string,
  episode: SimklEpisodeCoords | undefined,
  imdb?: string,
): Promise<boolean> {
  const wanted = new Set(simklLookupIds(metaId, imdb));
  let raw: RawSession[];
  try {
    raw = await simklRequest<RawSession[]>("/sync/playback?hide_watched=true&limit=40");
  } catch (e) {
    if (e instanceof SimklApiError && e.status === 404) return false;
    throw e;
  }
  if (!Array.isArray(raw)) return false;
  for (const r of raw) {
    const kind = r.movie ? "movie" : "show";
    const node = r.movie ?? r.show ?? r.anime;
    if (!node) continue;
    if (!simklEntryIdKeys(node.ids, kind).some((key) => wanted.has(key))) continue;
    if (!episode) return true;
    const season = r.episode?.season;
    const number = r.episode?.number ?? r.episode?.episode;
    if (season == null && number == null) continue;
    if (simklEpisodeWatchKeys(episode).includes(`${season}:${number}`)) return true;
  }
  return false;
}

const SIMKL_PLAYBACK_CACHE_PREFIX = "harbor.simkl.playback_items.v2.";
const SIMKL_LEGACY_PLAYBACK_CACHE_KEY = "harbor.simkl.playback_items";
const SIMKL_WATCHING_MAX_AGE_MS = 365 * 864e5;

export type SimklPlaybackResult = { items: LibraryItem[]; fresh: boolean };

function simklCacheKeyFor(username?: string | null): string | null {
  const value = username?.trim().toLowerCase();
  return value ? `${SIMKL_PLAYBACK_CACHE_PREFIX}${encodeURIComponent(value)}` : null;
}

function simklAccountCacheKey(): string | null {
  return simklCacheKeyFor(getSession()?.username);
}

const memorySimklPlaybackCache = new Map<string, LibraryItem[]>();

/**
 * The old cache was a single global key that cannot be attributed to an
 * account. It is never read by the account-scoped implementation, so remove it
 * instead of leaving another account's progress on disk.
 */
function dropLegacySimklPlaybackCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SIMKL_LEGACY_PLAYBACK_CACHE_KEY);
  } catch {}
}

function isValidSimklPlaybackItem(item: LibraryItem): boolean {
  if (!item || item.external !== "simkl" || !item.state) return false;
  if (item.upNext || item.waitingForAir) {
    // A cached anchor must not outlive the same recency cap used for a live
    // fetch; old Watching entries otherwise reappear from the offline cache.
    const lastWatched = Date.parse(item.state.lastWatched ?? "");
    return (
      Number.isFinite(lastWatched) &&
      lastWatched > 0 &&
      Date.now() - lastWatched <= SIMKL_WATCHING_MAX_AGE_MS
    );
  }
  const offset = item.state.timeOffset ?? 0;
  const dur = item.state.duration ?? 0;
  if (offset <= 0 || (item.state.flaggedWatched ?? 0) > 0) return false;
  if (dur > 0 && offset / dur >= 0.9) return false;
  return true;
}

export function readCachedSimklPlaybackItems(): LibraryItem[] {
  dropLegacySimklPlaybackCache();
  const key = simklAccountCacheKey();
  if (!key) return [];
  const memory = memorySimklPlaybackCache.get(key);
  if (memory && memory.length > 0) {
    return memory.filter(isValidSimklPlaybackItem);
  }
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isValidSimklPlaybackItem);
        memorySimklPlaybackCache.set(key, valid);
        if (valid.length !== parsed.length) {
          try {
            localStorage.setItem(key, JSON.stringify(valid));
          } catch {}
        }
        return valid;
      }
    }
  } catch {}
  return [];
}

export function writeCachedSimklPlaybackItems(items: LibraryItem[]): void {
  dropLegacySimklPlaybackCache();
  const key = simklAccountCacheKey();
  if (!key) return;
  memorySimklPlaybackCache.set(key, items);
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {}
}

export function clearCachedSimklPlaybackItems(username?: string | null): void {
  const target = username === undefined ? null : simklCacheKeyFor(username);
  if (target) {
    memorySimklPlaybackCache.delete(target);
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(target);
    } catch {}
    return;
  }
  memorySimklPlaybackCache.clear();
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith(SIMKL_PLAYBACK_CACHE_PREFIX) || key === SIMKL_LEGACY_PLAYBACK_CACHE_KEY)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

export async function deleteSimklPlayback(
  id: string,
): Promise<{ ok: boolean; retryAfterMs?: number; rateLimited?: boolean }> {
  if (!id) return { ok: true };
  try {
    await simklRequest(`/sync/playback/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof SimklApiError)) return { ok: false };
    if (error.status === 404) return { ok: true };
    const retryAfterMs =
      error.retryAt != null ? Math.max(0, error.retryAt - Date.now()) : undefined;
    return {
      ok: false,
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
      ...(error.status === 429 || error.status === 412 ? { rateLimited: true } : {}),
    };
  }
}

const PLAYBACK_PAGE_LIMIT = 40;

export type SimklPlaybackSnapshot = { items: LibraryItem[]; complete: boolean };

/**
 * Live read for dismissal retries. `hide_watched=false` is required: the regular
 * list hides records watched after their pause, which would make a present record
 * look deleted. `complete` still fails closed at the page limit.
 */
export async function fetchSimklPlaybackSnapshot(): Promise<SimklPlaybackSnapshot> {
  const owner = getSession();
  if (!owner) return { items: [], complete: false };
  const raw = await simklRequest<RawSession[]>(
    `/sync/playback?hide_watched=false&limit=${PLAYBACK_PAGE_LIMIT}`,
  );
  if (getSession() !== owner) throw new Error("SIMKL session changed");
  if (!Array.isArray(raw)) throw new Error("Simkl playback response was not a list");
  return {
    items: await itemsFromRaw(raw, false, false),
    complete: raw.length < PLAYBACK_PAGE_LIMIT,
  };
}

async function itemsFromRaw(
  raw: RawSession[],
  backfill: boolean,
  dedupe = true,
): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const item = await toLibraryItem(r);
    if (!item?.state) continue;
    if (r.id != null) item.providerPlaybackIds = { simkl: String(r.id) };
    const node = r.movie ?? r.show ?? r.anime;
    if (node) {
      const altIds = simklEntryIdKeys(node.ids, item.type === "movie" ? "movie" : "show").filter(
        (id) => id !== item._id,
      );
      if (altIds.length > 0) item.altIds = altIds;
    }
    if (dedupe) {
      const key = `${item._id}|${item.state.season ?? ""}|${item.state.episode ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    items.push(item);
    if (!backfill) continue;
    // A dismissed card must not be resurrected by this backfill: dismiss clears the
    // resume entry, and rewriting it with t=now would manufacture fresh activity that
    // beats the dismissal. Genuine new progress still surfaces via paused_at/ratio.
    if (isCwDismissed(item)) continue;
    // Newer-wins backfill: overwrite a stale entry when the remote pause is newer
    // (paused_at) or, when the stored entry has no usable timestamp, further ahead.
    const existing = readResumeEntry(item._id, item.state.season, item.state.episode);
    const remoteT = Date.parse(item.state.lastWatched ?? "");
    const remoteValid = Number.isFinite(remoteT) && remoteT > 0;
    const shouldWrite =
      !existing ||
      (remoteValid && remoteT >= existing.t) ||
      (!existing.t && item.state.timeOffset > existing.ms);
    if (shouldWrite) {
      // Persist the true remote percent alongside the synthetic ms so consumers
      // can prefer pct x real runtime once migrated; pct rides along with the
      // winning write and is never mixed with another entry's ms.
      const pct01 = Math.min(100, Math.max(0, r.progress ?? 0)) / 100;
      saveResumeBatch([
        {
          id: item._id,
          ms: item.state.timeOffset,
          season: item.state.season,
          episode: item.state.episode,
          pct: pct01,
          source: "simkl",
          t: remoteValid ? remoteT : 0,
        },
      ]);
    }
  }
  return items;
}

export async function fetchSimklPlaybackItems(force = false): Promise<SimklPlaybackResult> {
  const owner = getSession();
  if (!owner) return { items: [], fresh: false };
  let raw: RawSession[];
  try {
    raw = await simklRequest<RawSession[]>("/sync/playback?hide_watched=true&limit=40");
  } catch (e) {
    if (e instanceof SimklApiError && e.status === 404) {
      writeCachedSimklPlaybackItems([]);
      return { items: [], fresh: true };
    }
    if (force) throw e;
    const cached = readCachedSimklPlaybackItems();
    if (cached.length > 0) return { items: cached, fresh: false };
    throw e;
  }
  if (getSession() !== owner) throw new Error("SIMKL session changed");
  if (!Array.isArray(raw)) return { items: [], fresh: true };

  const items = await itemsFromRaw(raw, true);
  const seenSeries = new Set<string>();
  for (const item of items) {
    seenSeries.add(item._id);
    const cleanId = item._id.replace(/^(series|movie|tmdb|tmdb:tv):/, "");
    seenSeries.add(cleanId);
    seenSeries.add(`tmdb:tv:${cleanId}`);
  }

  try {
    const progress = await loadSimklProgress();
    if (progress && Array.isArray(progress.completedSeries)) {
      const activeSeries = progress.completedSeries
        .filter((comp) => {
          if (!comp || !comp._id) return false;
          const status = progress.statuses.get(comp._id);
          const mtime = Date.parse(comp._mtime);
          if (!Number.isFinite(mtime)) return false;
          const age = Date.now() - mtime;
          if (status === "watching") return age <= SIMKL_WATCHING_MAX_AGE_MS;
          return status === "completed" && age < 90 * 86400 * 1000;
        })
        .sort((a, b) => Date.parse(b._mtime) - Date.parse(a._mtime))
        .slice(0, 40);

      for (const comp of activeSeries) {
        const cleanId = comp._id.replace(/^(series|movie|tmdb|tmdb:tv):/, "");
        if (
          seenSeries.has(comp._id) ||
          seenSeries.has(cleanId) ||
          seenSeries.has(`tmdb:tv:${cleanId}`)
        ) {
          continue;
        }
        if (isCwDismissed(comp)) continue;
        seenSeries.add(comp._id);
        seenSeries.add(cleanId);
        items.push({
          ...comp,
          upNext: true,
        });
      }
    }
  } catch {}

  writeCachedSimklPlaybackItems(items);
  return { items, fresh: true };
}
