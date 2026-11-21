import type { AnimeEpisodeCoords } from "@/lib/streams/anime-identity-core";

export type TrackerService = "trakt" | "simkl" | "mal" | "anilist";

export type TrackerEvidence = "pack+window" | "pack-only" | "anizip-delta";

export type TrackerWork = {
  /** Native anime entry that owns the episode (`kitsu:`/`mal:`/`anilist:`/`anidb:`). */
  entryId: string;
  /** Episode number relative to that entry, never a provider season coordinate. */
  entryEpisode: number;
  /** Entry URL carried by this row before a later-cour refinement (`baseId`). */
  baseEntryId?: string;
  aliases?: Partial<Record<"kitsu" | "mal" | "anilist" | "anidb", string>>;
  catalogIds: string[];
  evidence: TrackerEvidence;
};

export type TrackerCheckpoint = {
  metaId: string;
  catalogIds?: string[];
  season: number;
  episode: number;
  imdbSeason?: number;
  imdbEpisode?: number;
  isAnime?: boolean;
  /** Already-resolved owner when the player knows it (stream/sourceMetaId). */
  work?: TrackerWork | null;
};

export type TrackerTarget = {
  service: TrackerService;
  /**
   * Native entry for anime services. Catalog rows that are not anime use the
   * catalog id here so callers can still build their show/movie payload.
   */
  workEntry: string;
  /** Entry-relative anime episode, or the provider episode for catalog rows. */
  entryEpisode: number;
  providerCoords: { season: number; episode: number };
  catalogIds: string[];
  evidence: TrackerEvidence;
};

const CATALOG_ID = /^(?:tt\d+|tmdb:(?:tv|movie):\d+)$/;
const NATIVE_ID = /^(kitsu|mal|anilist|anidb):[1-9]\d*$/;

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/** Every catalog id a row carries; the resolver never invents one. */
export function trackerCatalogIds(checkpoint: TrackerCheckpoint): string[] {
  return unique([
    ...(checkpoint.catalogIds ?? []),
    CATALOG_ID.test(checkpoint.metaId) ? checkpoint.metaId : null,
  ]);
}

function nativeScheme(id: string | undefined): string | null {
  const match = NATIVE_ID.exec(id ?? "");
  return match ? match[1] : null;
}

function workNativeId(work: TrackerWork | null, scheme: string): string | null {
  if (!work) return null;
  if (nativeScheme(work.entryId) === scheme) return work.entryId;
  const alias = work.aliases?.[scheme as "kitsu" | "mal" | "anilist" | "anidb"];
  return alias && NATIVE_ID.test(alias) ? alias : null;
}

function preferredNativeId(work: TrackerWork | null): string | null {
  if (!work) return null;
  if (NATIVE_ID.test(work.entryId)) return work.entryId;
  for (const scheme of ["anidb", "mal", "kitsu", "anilist"] as const) {
    const id = workNativeId(work, scheme);
    if (id) return id;
  }
  return null;
}

function validEpisode(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function providerCoords(checkpoint: TrackerCheckpoint): { season: number; episode: number } | null {
  const season = checkpoint.imdbSeason ?? checkpoint.season;
  const episode = checkpoint.imdbEpisode ?? checkpoint.episode;
  return validEpisode(season) && validEpisode(episode) ? { season, episode } : null;
}

/**
 * Pure target decision from an already-resolved checkpoint.
 *
 * `null` means the proof is missing; callers keep their existing heuristic and
 * pending queue. This function never guesses an id or an episode number.
 */
export function trackerTargetFor(
  checkpoint: TrackerCheckpoint,
  service: TrackerService,
): TrackerTarget | null {
  const catalogIds = trackerCatalogIds(checkpoint);
  const coords = providerCoords(checkpoint);
  if (!coords) return null;
  const work = checkpoint.work ?? null;
  const evidence = work?.evidence ?? "pack-only";

  if (service === "trakt") {
    // Trakt is catalog-based: it needs an IMDb/TMDB show id and provider
    // coordinates. Native anime ids are not a Trakt show key.
    if (catalogIds.length === 0) return null;
    return {
      service,
      workEntry: work?.entryId ?? catalogIds[0],
      entryEpisode: work?.entryEpisode ?? coords.episode,
      providerCoords: coords,
      catalogIds,
      evidence,
    };
  }

  if (service === "simkl") {
    // Simkl Path B: anime writes go under `anime` with native ids and an
    // entry-relative episode. A catalog umbrella id is not proof of a Simkl
    // anime entry, so an anime row without a resolved work fails closed.
    if (checkpoint.isAnime === true && !work) return null;
    if (!work && catalogIds.length === 0) return null;
    const native = preferredNativeId(work);
    return {
      service,
      workEntry: native ?? work?.entryId ?? catalogIds[0],
      entryEpisode: work ? work.entryEpisode : coords.episode,
      providerCoords: coords,
      catalogIds,
      evidence,
    };
  }

  // MAL and AniList are native-entry APIs: no alias means no write.
  const id = workNativeId(work, service);
  if (!id || !work || !validEpisode(work.entryEpisode)) return null;
  return {
    service,
    workEntry: id,
    entryEpisode: work.entryEpisode,
    providerCoords: coords,
    catalogIds,
    evidence: work.evidence,
  };
}

export function trackerTargetsFor(checkpoint: TrackerCheckpoint): TrackerTarget[] {
  return (["trakt", "simkl", "mal", "anilist"] as const)
    .map((service) => trackerTargetFor(checkpoint, service))
    .filter((target): target is TrackerTarget => target != null);
}

export type TrackerTargetResolverDeps = {
  resolveEntry?: (
    metaId: string,
    coords: AnimeEpisodeCoords,
  ) => Promise<{ id: string; episode: number; baseId: string } | null>;
  aliases?: (
    entryId: string,
  ) => Promise<Partial<Record<"kitsu" | "mal" | "anilist" | "anidb", string>>>;
};

async function defaultResolveEntry(metaId: string, coords: AnimeEpisodeCoords) {
  const { resolveTrackerAnimeEntry } = await import("@/lib/anime-tracker-entry");
  return resolveTrackerAnimeEntry(metaId, coords);
}

async function defaultAliases(entryId: string) {
  const { anilistToMal, kitsuToAnilist, kitsuToMal } =
    await import("@/lib/providers/anime-mapping");
  const [scheme, raw] = entryId.split(":");
  const id = Number(raw);
  if (!Number.isFinite(id)) return {};
  if (scheme === "kitsu") {
    const [mal, anilist] = await Promise.all([
      kitsuToMal(id).catch(() => null),
      kitsuToAnilist(id).catch(() => null),
    ]);
    return {
      kitsu: entryId,
      ...(mal != null ? { mal: `mal:${mal}` } : {}),
      ...(anilist != null ? { anilist: `anilist:${anilist}` } : {}),
    };
  }
  if (scheme === "anilist") {
    const mal = await anilistToMal(id).catch(() => null);
    return { anilist: entryId, ...(mal != null ? { mal: `mal:${mal}` } : {}) };
  }
  return { [scheme]: entryId };
}

/**
 * Resolve a checkpoint into provider targets. Any provider outage or missing
 * proof resolves to an empty list; callers keep their current heuristic.
 */
export async function resolveTrackerTargets(
  checkpoint: TrackerCheckpoint,
  deps: TrackerTargetResolverDeps = {},
): Promise<TrackerTarget[]> {
  if (checkpoint.work !== undefined) return trackerTargetsFor(checkpoint);
  const anime =
    checkpoint.isAnime === true || /^(kitsu|mal|anilist|anidb):/.test(checkpoint.metaId);
  if (!anime) return trackerTargetsFor({ ...checkpoint, work: null });

  const coords: AnimeEpisodeCoords = {
    season: checkpoint.season,
    episode: checkpoint.episode,
    imdbSeason: checkpoint.imdbSeason,
    imdbEpisode: checkpoint.imdbEpisode,
  };
  let resolved: Awaited<ReturnType<typeof defaultResolveEntry>> = null;
  try {
    resolved = await (deps.resolveEntry ?? defaultResolveEntry)(checkpoint.metaId, coords);
  } catch {
    return [];
  }
  if (!resolved) return [];

  let aliases: Awaited<ReturnType<typeof defaultAliases>> = {};
  try {
    aliases = await (deps.aliases ?? defaultAliases)(resolved.id);
  } catch {
    aliases = {};
  }
  const work: TrackerWork = {
    entryId: resolved.id,
    entryEpisode: resolved.episode,
    baseEntryId: resolved.baseId,
    aliases,
    catalogIds: trackerCatalogIds(checkpoint),
    evidence: "anizip-delta",
  };
  return trackerTargetsFor({ ...checkpoint, work });
}
