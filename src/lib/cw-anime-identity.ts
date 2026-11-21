import {
  getAnimeCanonicalId,
  getAnimeCwId,
  getAnilistMalAlias,
  recordAnilistMalAlias,
  recordAnimeCwId,
  notifyAnimeCwIds,
} from "@/lib/anime-cw-ids";
import {
  animeDbReadEntry,
  animeDbReadProvider,
  animeDbWriteProvider,
} from "@/lib/anime-identity-db";
import { resolveAnimeEntry } from "@/lib/providers/anime-entry";
import { animeKitsuMeta, type AnimeKitsuMeta } from "@/lib/providers/anime-kitsu-addon";
import { resolveTrackerAnimeEntry } from "@/lib/anime-tracker-entry";
import { anilistAnimeEntry } from "@/lib/anilist/entry";

const KITSU_ID = /^kitsu:[1-9]\d*$/;
const KITSU_STREAM = /^kitsu:([1-9]\d*):[1-9]\d*$/;
const nativeEntry = /^(kitsu|mal|anilist|anidb):[1-9]\d*$/;
const catalogEntry = /^(?:tt\d+|tmdb:tv:[1-9]\d*)$/;
const CACHE_MAX = 512;
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 60 * 1000;
const NATIVE_DB_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 4;

export type CwAnimeCoords = { season?: number; episode?: number; imdbId?: string | null };
type CwIdentityItem = {
  _id?: string;
  id?: string;
  videoId?: string | null;
  name?: string;
  type?: string;
  isAnime?: boolean;
  local?: boolean;
  altIds?: string[];
  source?: string;
  sourceId?: string;
  externalId?: string;
  external?: string;
  state?: {
    video_id?: string | null;
    season?: number;
    episode?: number;
    time?: number;
    timeOffset?: number;
    duration?: number;
    lastWatched?: string | number;
    imdb_id?: string | null;
  };
  imdb_id?: string | null;
  season?: number;
  episode?: number;
  timeOffset?: number;
  duration?: number;
  lastWatched?: string | number;
  manualWatched?: boolean;
  cwMembers?: CwIdentityItem[];
};

/** Identity inputs that can change the proof without changing the checkpoint. */
export type CwWarmIdentityItem = {
  _id?: string;
  id?: string;
  type?: string;
  isAnime?: boolean;
  videoId?: string | null;
  season?: number;
  episode?: number;
  imdb_id?: string | null;
  altIds?: string[];
  state?: {
    video_id?: string | null;
    season?: number;
    episode?: number;
    imdb_id?: string | null;
  };
  cwMembers?: CwWarmIdentityItem[];
};

export function cwWarmIdentityKey(item: CwWarmIdentityItem, depth = 0): string {
  const state = item.state;
  // shortcut: nested CW groups stop at four levels; current dedupe output is shallower.
  const members =
    depth < 4
      ? (item.cwMembers ?? []).map((member) => cwWarmIdentityKey(member, depth + 1)).join(",")
      : "";
  return [
    item._id ?? "",
    item.id ?? "",
    item.type ?? "",
    item.isAnime ? "1" : "0",
    item.videoId ?? state?.video_id ?? "",
    item.season ?? state?.season ?? "",
    item.episode ?? state?.episode ?? "",
    item.imdb_id ?? state?.imdb_id ?? "",
    [...(item.altIds ?? [])].sort().join(","),
    members,
  ].join("|");
}

const resolvedCatalogImdb = new Map<string, string>();

function proofKey(id: string, videoId: string | null | undefined, coords: CwAnimeCoords): string {
  const imdbId = /^tt\d+$/.test(id) ? id : (coords.imdbId ?? "");
  return `cw-anime-proof:v1:${encodeURIComponent(id)}:${encodeURIComponent(videoId ?? "")}:${coords.season ?? ""}:${coords.episode ?? ""}:${encodeURIComponent(imdbId)}`;
}

function sourceImdbFor(item: CwIdentityItem, id: string): string | null {
  if (/^tt\d+$/.test(id)) return id;
  const alt = item.altIds?.find((value) => /^tt\d+$/.test(value));
  return item.imdb_id ?? item.state?.imdb_id ?? alt ?? resolvedCatalogImdb.get(id) ?? null;
}

function checkpointCoords(
  item: CwIdentityItem,
  id: string,
  videoId: string | null | undefined,
): CwAnimeCoords {
  let season = item.season ?? item.state?.season;
  let episode = item.episode ?? item.state?.episode;
  if (
    (!Number.isInteger(season) || !Number.isInteger(episode)) &&
    catalogEntry.test(id) &&
    videoId
  ) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}:([1-9]\\d*):([1-9]\\d*)$`).exec(videoId);
    if (match) {
      season = Number(match[1]);
      episode = Number(match[2]);
    }
  }
  return { season, episode, imdbId: sourceImdbFor(item, id) };
}

/** IMDb id discovered during background proof, so later synchronous passes can reuse it. */
export function getCachedCatalogImdb(id: string): string | null {
  return resolvedCatalogImdb.get(id) ?? null;
}

const catalogProofs = new Map<string, { identity: string | null; expiresAt: number }>();
const warmInflight = new Map<string, Promise<void>>();
const warmCache = new Map<string, { identity: string | null; expiresAt: number }>();
const WARM_NOTIFY_QUIET_MS = 50;
const WARM_NOTIFY_MAX_MS = 200;
let warmNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let warmNotifyDeadline = 0;

/** Coalesce identity notifications into a short window without waiting for the whole batch. */
function scheduleWarmNotify(): void {
  const now = Date.now();
  if (warmNotifyTimer == null) warmNotifyDeadline = now + WARM_NOTIFY_MAX_MS;
  else clearTimeout(warmNotifyTimer);
  const delay = Math.max(0, Math.min(WARM_NOTIFY_QUIET_MS, warmNotifyDeadline - now));
  warmNotifyTimer = setTimeout(() => {
    warmNotifyTimer = null;
    notifyAnimeCwIds();
  }, delay);
}
const nativeInflight = new Map<string, Promise<string | null>>();
const nativeCache = new Map<string, { identity: string | null; expiresAt: number }>();
let activeJobs = 0;
const waiters: Array<() => void> = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (activeJobs >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  else activeJobs++;
  try {
    return await run();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeJobs--;
  }
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max = CACHE_MAX): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

/** Offline CW identity. Catalog checkpoints require exact snapshot proof. */
export function cwAnimeIdentityKey(
  id: string,
  videoId?: string | null,
  coordinates?: CwAnimeCoords,
): string | null {
  // A saved Kitsu stream names the played cour even if the card ID has advanced.
  const stream = KITSU_STREAM.exec(videoId ?? "");
  if (stream) return `kitsu:${stream[1]}`;
  if (KITSU_ID.test(id)) return id;
  if (nativeEntry.test(id)) {
    const played = getAnimeCwId(id);
    const canonical = getAnimeCanonicalId(id);
    for (const candidate of [played, canonical])
      if (candidate && KITSU_ID.test(candidate)) return candidate;
    if (id.startsWith("mal:") || id.startsWith("anidb:") || id.startsWith("kitsu:")) return id;
    const alias = getAnilistMalAlias(id);
    if (!alias) return null;
    const resolved = getAnimeCwId(alias) ?? getAnimeCanonicalId(alias);
    return resolved && KITSU_ID.test(resolved) ? resolved : alias;
  }
  const checkpoint =
    coordinates ?? (catalogEntry.test(id) ? checkpointCoords({}, id, videoId) : undefined);
  if (checkpoint?.season == null || checkpoint.episode == null) return null;
  if (
    !Number.isInteger(checkpoint.season) ||
    checkpoint.season < 1 ||
    !Number.isInteger(checkpoint.episode) ||
    checkpoint.episode < 1
  )
    return null;
  const key = proofKey(id, videoId, checkpoint);
  const proof = catalogProofs.get(key);
  if (proof && proof.expiresAt > Date.now()) return proof.identity;
  if (proof) catalogProofs.delete(key);
  return null;
}

export type CwIdentityProofInput = {
  _id?: string;
  id?: string;
  videoId?: string | null;
  altIds?: string[];
  imdb_id?: string | null;
  state?: CwIdentityItem["state"];
  season?: number;
  episode?: number;
};

/** The verified checkpoint identity, using the same proof key as `warmOne`. */
export function provenCwAnimeIdentity(item: CwIdentityProofInput): string | null {
  const id = item._id ?? item.id ?? "";
  const videoId = item.videoId ?? item.state?.video_id;
  if (!id) return null;
  if (nativeEntry.test(id) || KITSU_ID.test(id)) return cwAnimeIdentityKey(id, videoId);
  if (!catalogEntry.test(id)) return null;
  return cwAnimeIdentityKey(id, videoId, checkpointCoords(item, id, videoId));
}

async function resolveNative(id: string): Promise<string | null> {
  const cached = nativeCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  const existing = nativeInflight.get(id);
  if (existing) return existing;
  const task = limited(async () => {
    const row = await animeDbReadEntry(id);
    const age = row ? Date.now() - row.updatedAt : Infinity;
    const storedId = row && age >= 0 && age <= NATIVE_DB_TTL ? row.ids.kitsu : null;
    if (typeof storedId === "number" && Number.isSafeInteger(storedId) && storedId > 0)
      return `kitsu:${storedId}`;
    const entry = await resolveAnimeEntry(id).catch(() => null);
    return entry && Number.isSafeInteger(entry.kitsuId) && entry.kitsuId > 0
      ? `kitsu:${entry.kitsuId}`
      : null;
  })
    .then((identity) => {
      boundedSet(nativeCache, id, {
        identity,
        expiresAt: Date.now() + (identity ? POSITIVE_TTL : NEGATIVE_TTL),
      });
      if (identity) {
        recordAnimeCwId(id, identity, false);
      }
      return identity;
    })
    .finally(() => nativeInflight.delete(id));
  nativeInflight.set(id, task);
  return task;
}

async function resolveCatalog(
  id: string,
  item: CwIdentityItem,
  coords: CwAnimeCoords,
): Promise<string | null> {
  const sourceImdb = sourceImdbFor(item, id);
  if (
    !sourceImdb ||
    !Number.isInteger(coords.season) ||
    coords.season! < 1 ||
    !Number.isInteger(coords.episode) ||
    coords.episode! < 1
  )
    return null;
  const candidate = await resolveTrackerAnimeEntry(id, {
    season: coords.season,
    episode: coords.episode,
  }).catch(() => null);
  if (!candidate) return null;
  const meta: AnimeKitsuMeta | null = await animeKitsuMeta(candidate.id).catch(() => null);
  if (!meta || meta.id !== candidate.id) return null;
  const exact = (meta.videos ?? []).filter(
    (video) =>
      video.imdb_id === sourceImdb &&
      video.imdbSeason === coords.season &&
      video.imdbEpisode === coords.episode,
  );
  if (exact.length === 0) return null;
  const entryIds = new Set(
    exact.map((video) => /^kitsu:([1-9]\d*):[1-9]\d*$/.exec(video.id)?.[1]).filter(Boolean),
  );
  if (entryIds.size > 1) return null;
  const metaKitsuId = /^kitsu:([1-9]\d*)$/.exec(meta.id)?.[1];
  const candidateKitsuId = /^kitsu:([1-9]\d*)$/.exec(candidate.id)?.[1];
  const provenId = metaKitsuId ?? candidateKitsuId;
  if (provenId && entryIds.size === 1 && !entryIds.has(provenId)) return null;
  return provenId ? `kitsu:${provenId}` : null;
}

const imdbInflight = new Map<string, Promise<string | null>>();

async function resolveTmdbImdb(id: string, tmdbKey: string): Promise<string | null> {
  const match = /^tmdb:tv:([1-9]\d*)$/.exec(id);
  if (!match) return null;
  const { tmdbImdbCached, tmdbImdbId } = await import("@/lib/providers/tmdb/tmdb-imdb-resolve");
  const cached = tmdbImdbCached(id);
  if (cached) return cached;
  if (tmdbKey) {
    const viaTmdb = await tmdbImdbId(tmdbKey, id).catch(() => null);
    if (viaTmdb) return viaTmdb;
  }
  const { getImdbForTmdb } = await import("@/lib/publicmetadb/mappings");
  return (await getImdbForTmdb(Number(match[1]), "tv").catch(() => null)) ?? null;
}

function ensureCatalogImdb(id: string, tmdbKey: string): Promise<string | null> {
  if (!/^tmdb:tv:[1-9]\d*$/.test(id)) return Promise.resolve(null);
  const known = resolvedCatalogImdb.get(id);
  if (known) return Promise.resolve(known);
  const existing = imdbInflight.get(id);
  if (existing) return existing;
  const task = limited(() => resolveTmdbImdb(id, tmdbKey))
    .then((imdb) => {
      if (imdb) boundedSet(resolvedCatalogImdb, id, imdb);
      return imdb;
    })
    .catch(() => null)
    .finally(() => imdbInflight.delete(id));
  imdbInflight.set(id, task);
  return task;
}

async function warmOne(item: CwIdentityItem, tmdbKey = ""): Promise<void> {
  const id = item._id ?? item.id ?? "";
  if (!id || KITSU_ID.test(id)) return;
  const videoId = item.videoId ?? item.state?.video_id;
  const isNative = nativeEntry.test(id);
  if (!isNative && !catalogEntry.test(id)) return;
  const coords: CwAnimeCoords = isNative ? {} : checkpointCoords(item, id, videoId);
  if (
    !isNative &&
    (!Number.isInteger(coords.season) ||
      coords.season! < 1 ||
      !Number.isInteger(coords.episode) ||
      coords.episode! < 1)
  )
    return;
  if (!isNative && !coords.imdbId) {
    const derived = await ensureCatalogImdb(id, tmdbKey).catch(() => null);
    if (derived) coords.imdbId = derived;
  }
  if (!isNative && !coords.imdbId) return;
  const snapshotKey = isNative ? `native:${id}` : proofKey(id, videoId, coords);
  const now = Date.now();
  const cached = warmCache.get(snapshotKey);
  if (cached && cached.expiresAt > now) {
    if (cached.identity && !isNative)
      boundedSet(catalogProofs, proofKey(id, videoId, coords), {
        identity: cached.identity,
        expiresAt: cached.expiresAt,
      });
    return;
  }
  const inflightKey = snapshotKey;
  const existing = warmInflight.get(inflightKey);
  if (existing) return existing;

  const task = (async () => {
    // The effective CW identity of a native row comes from the alias maps, not
    // from the warm cache, so that is what a notification has to be based on.
    const beforeNative = isNative ? (getAnimeCwId(id) ?? getAnimeCanonicalId(id)) : null;
    try {
      if (!isNative) {
        const stored = await animeDbReadProvider<{
          source: string;
          id: string;
          videoId: string | null;
          season?: number;
          episode?: number;
          imdbId?: string | null;
          candidateId?: string;
          identity: string | null;
        }>(snapshotKey);
        if (
          stored &&
          stored.expiresAt > Date.now() &&
          stored.value?.source === "exact-kitsu-addon-video" &&
          typeof stored.value.identity === "string" &&
          KITSU_ID.test(stored.value.identity) &&
          stored.value.id === id &&
          stored.value.videoId === (videoId ?? null) &&
          stored.value.season === coords.season &&
          stored.value.episode === coords.episode &&
          stored.value.imdbId === (coords.imdbId ?? null) &&
          stored.value.candidateId === stored.value.identity
        ) {
          boundedSet(warmCache, snapshotKey, {
            identity: stored.value.identity,
            expiresAt: stored.expiresAt,
          });
          if (stored.value.identity) {
            const key = proofKey(id, videoId, coords);
            const known = catalogProofs.get(key);
            const effective = known && known.expiresAt > Date.now() ? known.identity : null;
            boundedSet(catalogProofs, key, {
              identity: stored.value.identity,
              expiresAt: stored.expiresAt,
            });
            // Restoring an identity the row already had does not change what CW
            // renders, so it must not invalidate the row.
            if (effective !== stored.value.identity) scheduleWarmNotify();
          }
          return;
        }
      }
      const identity = await (isNative
        ? resolveNative(id)
        : limited(() => resolveCatalog(id, item, coords)));
      const expiresAt = Date.now() + (identity ? POSITIVE_TTL : NEGATIVE_TTL);
      boundedSet(warmCache, snapshotKey, { identity, expiresAt });
      let identityChanged = true;
      if (identity && !isNative) {
        const key = proofKey(id, videoId, coords);
        const known = catalogProofs.get(key);
        identityChanged =
          (known && known.expiresAt > Date.now() ? known.identity : null) !== identity;
        boundedSet(catalogProofs, key, { identity, expiresAt });
      } else if (identity && isNative) {
        identityChanged = (getAnimeCwId(id) ?? getAnimeCanonicalId(id)) !== beforeNative;
      }
      if (identity && !isNative) {
        await animeDbWriteProvider({
          key: snapshotKey,
          value: {
            source: "exact-kitsu-addon-video",
            id,
            videoId: videoId ?? null,
            candidateId: identity,
            season: coords.season,
            episode: coords.episode,
            imdbId: coords.imdbId ?? null,
            identity,
          },
          expiresAt,
          fetchedAt: Date.now(),
        });
      }
      if (identity && identityChanged) scheduleWarmNotify();
    } catch {
      boundedSet(warmCache, snapshotKey, { identity: null, expiresAt: Date.now() + NEGATIVE_TTL });
    } finally {
      warmInflight.delete(inflightKey);
    }
  })();
  warmInflight.set(inflightKey, task);
  return task;
}

const MOVIE_ID = /^(?:tt\d+|tmdb:movie:[1-9]\d*)$/;

/** Verified movie IDs and warmed cross-catalog aliases; never derives identity from title. */
export function movieIdentityIds(item: CwIdentityItem): string[] {
  const id = item._id ?? item.id ?? "";
  if (item.type !== "movie" || item.isAnime || !MOVIE_ID.test(id)) return [];
  const cached = warmCache.get(`movie:${id}`);
  const mapped = cached && cached.expiresAt > Date.now() ? cached.identity : null;
  return [
    ...new Set(
      [id, ...(item.altIds ?? []), ...(mapped ? [mapped] : [])].filter((value) =>
        MOVIE_ID.test(value),
      ),
    ),
  ];
}

const movieIds = movieIdentityIds;

async function warmMovie(item: CwIdentityItem, tmdbKey: string): Promise<void> {
  const id = item._id ?? item.id ?? "";
  const aliases = movieIds(item);
  if (aliases.length === 0) return;
  if (
    aliases.some((alias) => alias.startsWith("tt")) &&
    aliases.some((alias) => alias.startsWith("tmdb:movie:"))
  )
    return;
  const key = `movie:${id}`;
  const cached = warmCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return;
  const existing = warmInflight.get(key);
  if (existing) return existing;
  const task = limited(async () => {
    const { tmdbImdbCached, tmdbFromImdbCached, tmdbImdbId } =
      await import("@/lib/providers/tmdb/tmdb-imdb-resolve");
    if (id.startsWith("tt")) {
      const tmdbId = tmdbFromImdbCached(id);
      return tmdbId && /^tmdb:movie:[1-9]\d*$/.test(tmdbId) ? tmdbId : null;
    }
    let imdb = tmdbImdbCached(id);
    if (!imdb && tmdbKey) imdb = await tmdbImdbId(tmdbKey, id).catch(() => null);
    if (!imdb) {
      const { getImdbForTmdb } = await import("@/lib/publicmetadb/mappings");
      imdb = await getImdbForTmdb(Number(id.slice("tmdb:movie:".length)), "movie").catch(
        () => null,
      );
    }
    return imdb && /^tt\d+$/.test(imdb) ? imdb : null;
  })
    .then((identity) => {
      boundedSet(warmCache, key, {
        identity,
        expiresAt: Date.now() + (identity ? POSITIVE_TTL : NEGATIVE_TTL),
      });
      if (identity) scheduleWarmNotify();
    })
    .catch(() => {
      boundedSet(warmCache, key, { identity: null, expiresAt: Date.now() + NEGATIVE_TTL });
    })
    .finally(() => warmInflight.delete(key));
  warmInflight.set(key, task);
  return task;
}

/**
 * A newly airing anime may have AniList and MAL IDs but no Kitsu entry yet.
 * Resolve AniList -> MAL only when both types are already present in this CW
 * cohort. Never infer identity from translated or romanized titles.
 *
 * AniList entry results use the existing media cache; accepted links use the
 * persisted, notifying anime ID alias map so both rooms update automatically.
 */
async function warmAnilistMalCwAliases(items: CwIdentityItem[]): Promise<void> {
  const malIds = new Set(
    items
      .map((item) => item._id ?? item.id ?? "")
      .filter((id) => /^mal:[1-9]\d*$/.test(id)),
  );
  if (malIds.size === 0) return;
  const anilistIds = [...new Set(
    items
      .map((item) => item._id ?? item.id ?? "")
      .filter((id) => /^anilist:[1-9]\d*$/.test(id) && !getAnilistMalAlias(id)),
  )];
  if (anilistIds.length === 0) return;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, anilistIds.length) }, async () => {
      while (cursor < anilistIds.length) {
        const id = anilistIds[cursor++];
        const number = Number(id.slice("anilist:".length));
        const entry = await anilistAnimeEntry(number, "anilist").catch(() => null);
        if (
          !entry ||
          entry.id !== number ||
          !Number.isSafeInteger(entry.idMal) ||
          entry.idMal == null ||
          entry.idMal <= 0 ||
          !malIds.has("mal:" + entry.idMal)
        ) continue;
        recordAnilistMalAlias(number, entry.idMal);
      }
    }),
  );
}
/**
 * The Kitsu addon can publish exact IMDb episode coordinates for a MAL entry
 * before AniZip publishes its IMDb/Kitsu IDs. Use that episode-level evidence
 * to bridge a catalog CW checkpoint to an existing native anime CW member.
 * Never infer this relationship from names or a series-wide IMDb ID alone.
 */
async function warmNativeCatalogCwProofs(items: CwIdentityItem[]): Promise<void> {
  const catalog = items.flatMap((item) => {
    const id = item._id ?? item.id ?? "";
    if (!catalogEntry.test(id) || item.type === "movie") return [];
    const videoId = item.videoId ?? item.state?.video_id;
    const coords = checkpointCoords(item, id, videoId);
    const imdbId = sourceImdbFor(item, id);
    if (
      !imdbId || !/^tt\d+$/.test(imdbId) ||
      !Number.isInteger(coords.season) || coords.season! < 1 ||
      !Number.isInteger(coords.episode) || coords.episode! < 1 ||
      cwAnimeIdentityKey(id, videoId, coords)
    ) return [];
    return [{ id, videoId, coords, imdbId }];
  });
  if (catalog.length === 0) return;
  const nativeIds = [...new Set(
    items.filter((item) => item.type !== "movie")
      .map((item) => item._id ?? item.id ?? "")
      .filter((id) => nativeEntry.test(id) || KITSU_ID.test(id)),
  )];
  if (nativeIds.length === 0) return;

  const metas = await Promise.all(
    nativeIds.map((id) => limited(() => animeKitsuMeta(id).catch(() => null))),
  );
  for (const entry of catalog) {
    const identities = new Set<string>();
    for (const meta of metas) {
      if (!meta || meta.type !== "series" || !KITSU_ID.test(meta.id)) continue;
      const found = meta.videos.some(
        (video) =>
          video.id.startsWith(`${meta.id}:`) &&
          /^kitsu:[1-9]\d*:[1-9]\d*$/.test(video.id) &&
          video.imdb_id === entry.imdbId &&
          video.imdbSeason === entry.coords.season &&
          video.imdbEpisode === entry.coords.episode,
      );
      if (found) identities.add(meta.id);
    }
    // Two entries claiming the same IMDb checkpoint are ambiguous, not proof.
    if (identities.size !== 1) continue;
    const identity = identities.values().next().value!;
    const key = proofKey(entry.id, entry.videoId, entry.coords);
    const previous = catalogProofs.get(key);
    if (previous && previous.expiresAt > Date.now()) {
      if (previous.identity && previous.identity !== identity) continue;
      if (previous.identity === identity) continue;
    }
    boundedSet(catalogProofs, key, {
      identity,
      expiresAt: Date.now() + POSITIVE_TTL,
    });
    scheduleWarmNotify();
  }
}

/** Resolve checkpoint snapshots with bounded concurrency shared across all callers. */
export async function warmCwAnimeIdentities(
  items: CwIdentityItem[],
  options: { tmdbKey?: string } = {},
): Promise<void> {
  const snapshots: CwIdentityItem[] = [];
  const visited = new Set<CwIdentityItem>();
  const flatten = (item: CwIdentityItem) => {
    if (visited.has(item)) return;
    visited.add(item);
    snapshots.push(item);
    item.cwMembers?.forEach(flatten);
  };
  items.forEach(flatten);
  await Promise.all([
    warmAnilistMalCwAliases(snapshots),
    warmNativeCatalogCwProofs(snapshots),
    ...snapshots.map((item) =>
      (movieIds(item).length > 0
        ? warmMovie(item, options.tmdbKey ?? "")
        : warmOne(item, options.tmdbKey ?? "")
      ).catch(() => undefined),
    ),
  ]);
}

function memberKey(item: CwIdentityItem): string {
  const state = item.state;
  return [
    item.source,
    item.external,
    item.local,
    item.sourceId,
    item.externalId,
    item._id ?? item.id,
    item.videoId ?? state?.video_id,
    item.season ?? state?.season,
    item.episode ?? state?.episode,
    item.timeOffset ?? state?.timeOffset ?? state?.time,
    item.duration ?? state?.duration,
    item.lastWatched ?? state?.lastWatched,
  ]
    .map((value) => String(value ?? ""))
    .join("|");
}

function rootOf(parents: Map<string, string>, id: string): string {
  if (!parents.has(id)) parents.set(id, id);
  let current = id;
  while (parents.get(current) !== current) current = parents.get(current)!;
  while (parents.get(id) !== id) {
    const next = parents.get(id)!;
    parents.set(id, current);
    id = next;
  }
  return current;
}

function newerAnimePlayback(incoming: CwIdentityItem, existing: CwIdentityItem): boolean {
  const timestamp = (item: CwIdentityItem) => {
    const value = item.lastWatched ?? item.state?.lastWatched;
    return typeof value === "number" ? value : Date.parse(value ?? "");
  };
  const incomingAt = timestamp(incoming);
  const existingAt = timestamp(existing);
  // Row ordering also includes library maintenance and resume-import times.
  // Only explicit playback timestamps may override that order for an alias.
  return (
    Number.isFinite(incomingAt) &&
    incomingAt > 0 &&
    Number.isFinite(existingAt) &&
    existingAt > 0 &&
    incomingAt > existingAt
  );
}

function mergeCwMembers<T extends CwIdentityItem>(existing: T, item: T): T {
  const members = [...(existing.cwMembers ?? [existing]), ...(item.cwMembers ?? [item])];
  const unique = [...new Map(members.map((member) => [memberKey(member), member])).values()];
  return { ...existing, cwMembers: unique } as T;
}

function normalizeSeriesId(value: string): string | null {
  if (/^tt\d+$/.test(value)) return value;
  const match = /^(?:tmdb:tv:|tv:|series:)([1-9]\d*)$/.exec(value);
  return match ? `tmdb:tv:${match[1]}` : null;
}

function seriesAliasIds(item: CwIdentityItem): string[] {
  if (item.type !== "series" || item.isAnime) return [];
  const id = normalizeSeriesId(item._id ?? item.id ?? "");
  if (!id) return [];
  const ids = new Set([id]);
  for (const alt of item.altIds ?? []) {
    const normalized = normalizeSeriesId(alt);
    if (normalized) ids.add(normalized);
  }
  return [...ids];
}

export function cwTitleKey(item: CwIdentityItem): string | null {
  const id = item._id ?? item.id ?? "";
  if (item.isAnime || /^(kitsu|mal|anilist|anidb):/.test(id)) return null;
  const name = (item.name ?? "")
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  if (!name) return null;
  return `${item.type === "movie" ? "movie" : "series"}|${name}`;
}

function isDerivedCwItem(item: CwIdentityItem): boolean {
  return item.local === true || item.manualWatched === true;
}

/** Items are freshness-sorted; retain every original source checkpoint. */
export function dedupeAnimeCw<T extends CwIdentityItem>(items: T[]): T[] {
  // Build movie and series alias components before picking survivors: a later
  // provider row can connect an earlier IMDb row to an earlier TMDB row.
  const parents = new Map<string, string>();
  const seriesParents = new Map<string, string>();
  const allItems = items.flatMap((entry) => [entry, ...(entry.cwMembers ?? [])]);
  for (const item of allItems) {
    const ids = movieIds(item);
    for (const id of ids.slice(1)) {
      parents.set(rootOf(parents, id), rootOf(parents, ids[0]));
    }
    const seriesIds = seriesAliasIds(item);
    for (const id of seriesIds.slice(1)) {
      seriesParents.set(rootOf(seriesParents, id), rootOf(seriesParents, seriesIds[0]));
    }
  }
  const imdbIds = new Map<string, Set<string>>();
  for (const id of parents.keys()) {
    if (!id.startsWith("tt")) continue;
    const key = rootOf(parents, id);
    const ids = imdbIds.get(key) ?? new Set<string>();
    ids.add(id);
    imdbIds.set(key, ids);
  }
  // Only ids that actually alias another series may switch identity. A lone
  // series keeps its old source identity so a not-yet-detected anime row and a
  // detected row with the same id still collapse.
  const seriesComponents = new Map<string, Set<string>>();
  for (const item of allItems) {
    for (const id of seriesAliasIds(item)) {
      const key = rootOf(seriesParents, id);
      const ids = seriesComponents.get(key) ?? new Set<string>();
      ids.add(id);
      seriesComponents.set(key, ids);
    }
  }
  const output: T[] = [];
  const indexes = new Map<string, number>();
  for (const item of items) {
    const sourceId = item._id ?? item.id ?? "";
    const videoId = item.videoId ?? item.state?.video_id;
    const kind = item.type === "movie" ? "movie" : "series";
    const movieAliases = movieIds(item);
    const movieGroup = movieAliases.length > 0 ? rootOf(parents, sourceId) : null;
    const movieIdentity =
      movieGroup && (imdbIds.get(movieGroup)?.size ?? 0) <= 1 ? `movie:${movieGroup}` : null;
    const animeIdentity = cwAnimeIdentityKey(
      sourceId,
      videoId,
      checkpointCoords(item, sourceId, videoId),
    );
    const seriesIds = seriesAliasIds(item);
    const seriesRoot = seriesIds.length > 0 ? rootOf(seriesParents, seriesIds[0]) : null;
    const seriesIdentity =
      seriesRoot && (seriesComponents.get(seriesRoot)?.size ?? 0) > 1
        ? `series:${seriesRoot}`
        : null;
    const identity =
      movieIdentity ??
      (animeIdentity
        ? `${kind}:${animeIdentity}`
        : (seriesIdentity ?? (sourceId ? `source:${kind}:${sourceId}` : null)));
    if (!identity) {
      output.push(item);
      continue;
    }
    const index = indexes.get(identity);
    if (index == null) {
      indexes.set(identity, output.length);
      output.push(item);
      continue;
    }
    const existing = output[index];
    output[index] =
      animeIdentity && newerAnimePlayback(item, existing)
        ? mergeCwMembers(item, existing)
        : mergeCwMembers(existing, item);
  }

  // A manual-watched or local row can carry the playback id while the real
  // library row uses the other canonical id. Merge those by exact title, but
  // never merge two ordinary library rows that merely share a name.
  const final: T[] = [];
  const titleIndexes = new Map<string, number>();
  const derivedIndexes = new Set<number>();
  for (const item of output) {
    const title = cwTitleKey(item);
    if (title) {
      const index = titleIndexes.get(title);
      if (index != null && (isDerivedCwItem(item) || derivedIndexes.has(index))) {
        final[index] = mergeCwMembers(final[index], item);
        derivedIndexes.add(index);
        continue;
      }
      if (index == null) {
        titleIndexes.set(title, final.length);
        if (isDerivedCwItem(item)) derivedIndexes.add(final.length);
      }
    }
    final.push(item);
  }
  return final;
}
