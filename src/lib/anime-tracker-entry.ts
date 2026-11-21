import { aniZipByAnilist, type AniZipMapping } from "@/lib/providers/anizip";
import {
  animeMappingByKitsu,
  imdbToKitsu,
  kitsuToAnilist,
  tmdbTvToKitsu,
} from "@/lib/providers/anime-mapping";
import { resolveExternalKitsuId } from "@/lib/providers/anime-entry";
import { parseKitsuId } from "@/lib/providers/kitsu";
import {
  animeCoordPairs,
  findAnimeEntryNumber,
  type AnimeEpisodeCoords,
} from "@/lib/streams/anime-identity-core";

export type TrackerAnimeEntry = { id: string; episode: number; baseId: string };

export type TrackerEntryDeps = {
  baseKitsuId: (metaId: string) => Promise<number | null>;
  azByKitsu: (kitsuId: number) => Promise<AniZipMapping | null>;
  anilistOfKitsu: (kitsuId: number) => Promise<number | null>;
  sequels: (anilistId: number) => Promise<Array<{ id: number }>>;
  kitsuOfAnilist: (anilistId: number) => Promise<number | null>;
};

function catalogBaseKitsuId(metaId: string, strict = false): Promise<number | null> {
  const direct = parseKitsuId(metaId);
  if (direct != null) return Promise.resolve(direct);
  if (metaId.startsWith("mal:") || metaId.startsWith("anilist:") || metaId.startsWith("anidb:")) {
    return resolveExternalKitsuId(metaId, undefined, strict);
  }
  if (/^tt\d+/.test(metaId))
    return strict ? imdbToKitsu(metaId, true) : imdbToKitsu(metaId).catch(() => null);
  const tmdb = /^tmdb:tv:(\d+)/.exec(metaId);
  if (tmdb)
    return strict
      ? tmdbTvToKitsu(Number(tmdb[1]), true)
      : tmdbTvToKitsu(Number(tmdb[1])).catch(() => null);
  return Promise.resolve(null);
}

function kitsuOfAnilist(anilistId: number, strict = false): Promise<number | null> {
  const az = strict
    ? aniZipByAnilist(anilistId, undefined, true)
    : aniZipByAnilist(anilistId).catch(() => null);
  return az.then((value) => {
    if (typeof value?.mappings?.kitsu_id === "number") return value.mappings.kitsu_id;
    return resolveExternalKitsuId(`anilist:${anilistId}`, undefined, strict);
  });
}

/** Highest provider season an AniZip entry covers; a flat entry covers season 1. */
function maxCoveredSeason(az: AniZipMapping | null): number {
  let max = 1;
  for (const m of Object.values(az?.episodes ?? {})) {
    if (typeof m.seasonNumber === "number" && m.seasonNumber > max) max = m.seasonNumber;
  }
  return max;
}

function sequelsOf(anilistId: number, strict: boolean) {
  return (async () => {
    const relations = strict
      ? await (await import("@/lib/anilist/relations")).animeRelations(anilistId, { strict: true })
      : await (await import("@/lib/anilist/relations")).animeRelations(anilistId).catch(() => []);
    // Provider seasons advance through TV cours; OVAs and specials sit between
    // them and would shift the hop to the wrong entry.
    return relations
      .filter((r) => r.kind === "sequel" && r.format !== "OVA" && r.format !== "SPECIAL")
      .map((r) => ({ id: r.id }));
  })();
}

/**
 * Best effort, used by playback and scrobbling: an unavailable provider resolves
 * to "nothing found" so the caller's own fallback runs.
 */
const DEFAULT_DEPS: TrackerEntryDeps = {
  baseKitsuId: (metaId) => catalogBaseKitsuId(metaId),
  azByKitsu: (kitsuId) => animeMappingByKitsu(kitsuId).catch(() => null),
  anilistOfKitsu: (kitsuId) => kitsuToAnilist(kitsuId).catch(() => null),
  sequels: (anilistId) => sequelsOf(anilistId, false),
  kitsuOfAnilist: (anilistId) => kitsuOfAnilist(anilistId).catch(() => null),
};

/**
 * CW advancement cannot treat an unavailable provider as "no sequel": that
 * answer removes the card. Every lookup here propagates the failure instead.
 */
const STRICT_DEPS: TrackerEntryDeps = {
  baseKitsuId: (metaId) => catalogBaseKitsuId(metaId, true),
  azByKitsu: (kitsuId) => animeMappingByKitsu(kitsuId, [], undefined, true),
  anilistOfKitsu: (kitsuId) => kitsuToAnilist(kitsuId, undefined, true),
  sequels: (anilistId) => sequelsOf(anilistId, true),
  kitsuOfAnilist: (anilistId) => kitsuOfAnilist(anilistId, true),
};

/**
 * Resolve the tracker entry that owns a row's episode. Newly aired
 * sequels/cours publish their AniZip/anime-lists mapping days after the episode,
 * so an IMDb/TMDB row mapped to its parent entry — or a Kitsu entry with no
 * cross-ids — resolves only to the earlier cour.
 *
 * This reproduces the row's own resolution first, then walks the franchise to
 * the cour that aired the requested provider season. The result carries the
 * chosen `id` plus the row's `baseId`, so a caller can tell "same entry" from
 * "later cour" and keep a stream-scoped cour as its own priority.
 */
/**
 * Strict wrapper for CW advancement: an unavailable provider rejects instead of
 * answering "no sequel", so the card is kept and retried later.
 */
export function resolveTrackerAnimeEntryStrict(
  metaId: string,
  coords: AnimeEpisodeCoords,
): Promise<TrackerAnimeEntry | null> {
  return resolveTrackerAnimeEntry(metaId, coords, undefined, true);
}

export async function resolveTrackerAnimeEntry(
  metaId: string,
  coords: AnimeEpisodeCoords,
  overrides?: Partial<TrackerEntryDeps>,
  strict = false,
): Promise<TrackerAnimeEntry | null> {
  const deps: TrackerEntryDeps = { ...(strict ? STRICT_DEPS : DEFAULT_DEPS), ...overrides };
  const pairs = animeCoordPairs(coords);
  if (pairs.length === 0) return null;
  const [targetSeason, targetEpisode] = pairs[0];

  const baseKitsu = await deps.baseKitsuId(metaId);
  if (baseKitsu == null) return null;
  const baseId = `kitsu:${baseKitsu}`;

  const baseAz = await deps.azByKitsu(baseKitsu);
  const direct = findAnimeEntryNumber(baseAz, pairs);
  if (direct != null) return { id: baseId, episode: direct, baseId };

  // Only a provider season past what the mapped entry covers can be a sequel.
  // An earlier or already-covered season is left to the caller's fallbacks.
  const hop = targetSeason - maxCoveredSeason(baseAz);
  if (hop < 1) return null;

  const baseAnilist = await deps.anilistOfKitsu(baseKitsu);
  if (baseAnilist == null) return null;
  const sequels = await deps.sequels(baseAnilist);
  const target = sequels[hop - 1];
  if (!target) return null;

  const seqKitsu = await deps.kitsuOfAnilist(target.id);
  if (seqKitsu != null) {
    const seqAz = await deps.azByKitsu(seqKitsu);
    const number = findAnimeEntryNumber(seqAz, pairs) ?? targetEpisode;
    return { id: `kitsu:${seqKitsu}`, episode: number, baseId };
  }
  // AniList keeps the sequel even when no Kitsu/cross mapping exists yet.
  return { id: `anilist:${target.id}`, episode: targetEpisode, baseId };
}
