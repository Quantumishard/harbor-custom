import { activeScopedProfileId } from "./active-profile-id";
import { airedOnly } from "./aired";
import { meta as fetchMeta, type Meta } from "./cinemeta";
import { createManualWatchedReader, manualWatchedRawKeys } from "./manual-watched";
import type { LibraryItem } from "./stremio";
import { decodeWatchedEpisodes } from "./stremio-watched";
import { isWatchedFlagged } from "./watched-flag";

const CACHE_PREFIX = "harbor.watchlistSeriesFinished.v1.";
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

type CacheEntry = { sig: string; finished: boolean; at: number };

export type SeriesFinishedCandidate = {
  id: string;
  imdbId?: string | null;
  type: "series" | "anime";
  videos?: Meta["videos"];
  stremio?: LibraryItem;
};

function cacheKey(): string {
  return CACHE_PREFIX + activeScopedProfileId();
}

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(cacheKey());
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<CacheEntry>;
      if (typeof entry.sig !== "string" || typeof entry.finished !== "boolean") continue;
      if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
      out[id] = { sig: entry.sig, finished: entry.finished, at: entry.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(id: string, entry: CacheEntry): void {
  try {
    const cache = readCache();
    cache[id] = entry;
    const now = Date.now();
    const entries = Object.entries(cache)
      .filter(([, value]) => now - value.at <= CACHE_MAX_AGE)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_MAX_ENTRIES);
    localStorage.setItem(cacheKey(), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Cache is an optimization; a failed write must never fail the check.
  }
}

function manualSignature(id: string, imdbId: string | null): string {
  const wanted = imdbId ? new Set([id, imdbId]) : new Set([id]);
  const keys: string[] = [];
  for (const key of manualWatchedRawKeys()) {
    const owner = key.slice(0, key.indexOf("|"));
    if (wanted.has(owner)) keys.push(key);
  }
  keys.sort();
  let hash = 0;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return `${keys.length}:${hash}`;
}

/** Released episodes in canonical season/episode order, as `season:episode`. */
export function releasedEpisodeKeys(
  videos: Meta["videos"] | undefined,
  type: "series" | "anime",
): string[] {
  if (!videos?.length) return [];
  const defaultSeason = type === "anime" ? 1 : 0;
  const ordered = videos
    .flatMap((video) => {
      const season = video.season ?? defaultSeason;
      const episode = video.episode ?? video.number;
      return Number.isInteger(season) && season >= 1 && Number.isInteger(episode) && episode! >= 1
        ? [{ season, episode: episode!, released: video.released ?? video.firstAired }]
        : [];
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return [
    ...new Set(
      airedOnly(ordered, (video) => video.released).map(
        (video) => `${video.season}:${video.episode}`,
      ),
    ),
  ];
}

function signature(
  candidate: SeriesFinishedCandidate,
  released: string[],
  imdbId: string | null,
): string {
  const item = candidate.stremio;
  return [
    released.length,
    released[released.length - 1] ?? "",
    item?._mtime ?? "",
    item?.state?.watched ?? "",
    item?.state?.timeOffset ?? 0,
    item?.state?.timesWatched ?? 0,
    item?.state?.flaggedWatched ?? 0,
    manualSignature(candidate.id, imdbId),
    isWatchedFlagged(candidate.id) || (imdbId ? isWatchedFlagged(imdbId) : false) ? 1 : 0,
  ].join("|");
}

/**
 * Resolve whether every released episode of a series is watched. Returns null
 * when the episode list is unavailable, so callers keep the title in Watchlist.
 */
export async function isSeriesFinished(
  candidate: SeriesFinishedCandidate,
): Promise<boolean | null> {
  const imdbId = candidate.imdbId ?? null;
  if (isWatchedFlagged(candidate.id) || (imdbId && isWatchedFlagged(imdbId))) return true;

  // The Stremio watched bitfield is indexed against Stremio/Cinemeta's video
  // order. Prefer that list over an addon-local copy; the metadata is cached.
  let videos = candidate.videos;
  if (candidate.stremio?.state?.watched) {
    const canonical = await fetchMeta("series", imdbId ?? candidate.id)
      .then((meta) => meta?.videos)
      .catch(() => undefined);
    if (canonical?.length) videos = canonical;
  } else if (!videos?.length) {
    videos = (await fetchMeta("series", imdbId ?? candidate.id).catch(() => null))?.videos;
  }
  if (!videos?.length) return null;

  const released = releasedEpisodeKeys(videos, candidate.type);
  if (released.length === 0) return null;

  const cacheId = imdbId ?? candidate.id;
  const sig = signature(candidate, released, imdbId);
  const cached = readCache()[cacheId];
  if (cached?.sig === sig) return cached.finished;

  const manual = createManualWatchedReader();
  const stremioWatched = candidate.stremio?.state?.watched
    ? await decodeWatchedEpisodes(candidate.stremio.state.watched, videos).catch(
        () => new Set<string>(),
      )
    : new Set<string>();

  for (const key of released) {
    const [season, episode] = key.split(":").map(Number);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
    const local = manual(candidate.id, season, episode, [imdbId]);
    // An explicit local unwatch wins over a stale provider bitfield.
    if (local === false) {
      writeCache(cacheId, { sig, finished: false, at: Date.now() });
      return false;
    }
    if (local !== true && !stremioWatched.has(key)) {
      writeCache(cacheId, { sig, finished: false, at: Date.now() });
      return false;
    }
  }

  writeCache(cacheId, { sig, finished: true, at: Date.now() });
  return true;
}
