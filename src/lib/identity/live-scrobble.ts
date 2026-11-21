import type { PlayEpisode, PlayerSrc } from "@/lib/view";
import type { PmdbTarget } from "@/lib/publicmetadb/types";
import type { TraktTarget } from "@/lib/trakt/types";
import type { TrackerWork } from "@/lib/tracker-targets";
import type { IdentityBundle, IdentityCardHint, IdentityWindow, IdentityWindowOwner } from "./types";
import { fetchCardHints, fetchWindowOwners } from "./hints";
import { identityBundle } from "./index";
import { identityEnabled } from "./flags";

const STREAM = /^kitsu:([1-9]\d*):([1-9]\d*)$/;
const NATIVE = /^(?:kitsu|mal|anilist|anidb):[1-9]\d*$/;
const CATALOG_SHOW = /^tmdb:tv:([1-9]\d*)$/;
const NATIVE_SCHEMES = new Set(["kitsu", "mal", "anilist", "anidb"]);
const TV_TYPES = new Set(["TV", "ONA"]);

export type LiveAnimeProof = {
  /** The player and resume history keep their original metadata identity. */
  work: TrackerWork;
  episode: PlayEpisode;
  /** Direct catalog targets only where the pack confirms the exact numbering. */
  traktTarget: TraktTarget | null;
  pmdbTarget: PmdbTarget | null;
};

export type LiveScrobbleDeps = {
  enabled: () => boolean;
  hints: (ids: string[]) => Promise<IdentityCardHint[] | null>;
  owners: (show: { tvdb: number | null; tmdb: number | null }, season: number) => Promise<IdentityWindowOwner[]>;
  bundle: (id: string) => Promise<IdentityBundle | null>;
};

const DEFAULT: LiveScrobbleDeps = {
  enabled: identityEnabled,
  hints: fetchCardHints,
  owners: fetchWindowOwners,
  bundle: identityBundle,
};

function singleAliasMap(bundle: IdentityBundle): TrackerWork["aliases"] | null {
  const aliases: NonNullable<TrackerWork["aliases"]> = {};
  for (const alias of bundle.aliases) {
    if (!NATIVE_SCHEMES.has(alias.scheme) || !/^[1-9]\d*$/.test(alias.id)) continue;
    const scheme = alias.scheme as keyof NonNullable<TrackerWork["aliases"]>;
    const value = `${scheme}:${alias.id}`;
    if (aliases[scheme] && aliases[scheme] !== value) return null;
    aliases[scheme] = value;
  }
  return aliases;
}

function relevantWindow(
  windows: readonly IdentityWindow[],
  season: number,
  catalogId: string,
): IdentityWindow | null {
  const expectedTmdb = CATALOG_SHOW.exec(catalogId);
  const possible = windows.filter((w) =>
    (w.tvdbSeason === season || w.tmdbSeason === season) &&
    (!expectedTmdb || w.tmdbtv === Number(expectedTmdb[1])));
  const unique = new Map(possible.map((w) =>
    [`${w.tvdb ?? ""}|${w.tmdbtv ?? ""}|${w.tvdbSeason ?? ""}|${w.tmdbSeason ?? ""}`, w]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function verifiedSource(hints: IdentityCardHint[], streamId: string, sourceId: string, targetEntry: number): boolean {
  if (!NATIVE.test(sourceId) || sourceId === streamId) return true;
  const source = hints.find((hint) => hint.id === sourceId);
  if (!source?.entry || source.provisional) return false;
  if (source.entry === targetEntry) return true;
  // A saved entry from an earlier cour must belong to the same provider show.
  const dest = hints.find((hint) => hint.id === streamId);
  return Boolean(dest && source.windows?.some((a) =>
    dest.windows?.some((b) =>
      (a.tvdb != null && a.tvdb === b.tvdb &&
        (a.tmdbtv == null || b.tmdbtv == null || a.tmdbtv === b.tmdbtv)) ||
      (a.tmdbtv != null && a.tmdbtv === b.tmdbtv &&
        (a.tvdb == null || b.tvdb == null || a.tvdb === b.tvdb)))));
}

/**
 * Stage 1. Resolve at playback start, not on Home render. The video id is
 * stronger than the franchise/catalog row, but it still must match a real
 * nonprovisional database entry, its episode range and a unique season owner.
 * No name/title matching or synthetic numeric season guessing.
 */
export async function resolveLiveAnimeScrobble(
  src: Pick<PlayerSrc, "meta" | "episode" | "isAnime" | "imdbId">,
  deps: LiveScrobbleDeps = DEFAULT,
): Promise<LiveAnimeProof | null> {
  const ep = src.episode;
  if (!deps.enabled() || !ep ||
      !Number.isSafeInteger(ep.season) || ep.season < 1 ||
      !Number.isSafeInteger(ep.episode) || ep.episode < 1 ||
      src.meta.type === "movie" || src.meta.type === "channel") return null;
  const nativeStream = STREAM.exec(ep.kitsuStreamId ?? "");
  const nativeId = nativeStream
    ? `kitsu:${nativeStream[1]}`
    : NATIVE.test(ep.sourceMetaId ?? "") ? ep.sourceMetaId!
    : NATIVE.test(src.meta.id) ? src.meta.id : null;
  if (!nativeId) return null;
  // The pack only knows TVDB/TMDB show windows. An IMDb page is not linked
  // to those windows until the *native episode* independently names the same
  // IMDb show and provider coordinates (AniZip/Kitsu episode mapping).
  // Otherwise a stale stream from any unrelated series with that season can
  // redirect five tracker writes to the wrong work.
  if (/^tt[1-9]\d*$/.test(src.meta.id) &&
      (ep.imdbId !== src.meta.id ||
       !Number.isSafeInteger(ep.imdbSeason) || ep.imdbSeason! < 1 ||
       !Number.isSafeInteger(ep.imdbEpisode) || ep.imdbEpisode! < 1)) return null;
  const number = nativeStream ? Number(nativeStream[2]) : ep.episode;

  // Explicitly verify the native work and episode from the installed pack.
  const [bundle, hints] = await Promise.all([
    deps.bundle(nativeId),
    deps.hints(nativeId === src.meta.id ? [nativeId] : [nativeId, src.meta.id]),
  ]);
  const hint = hints?.find((row) => row.id === nativeId);
  if (!bundle?.entry || !hint?.entry || hint.provisional ||
      hint.entry !== bundle.entry || !TV_TYPES.has(bundle.mediaType ?? "") ||
      !Number.isSafeInteger(bundle.episodes) || (bundle.episodes ?? 0) < number ||
      !Number.isSafeInteger(number) || number < 1) return null;
  if (!verifiedSource(hints ?? [], nativeId, src.meta.id, bundle.entry)) return null;

  const season = ep.imdbSeason ?? ep.season;
  const window = relevantWindow(bundle.windows, season, src.meta.id);
  if (!window || (window.tvdb == null && window.tmdbtv == null)) return null;
  const show = { tvdb: window.tvdb, tmdb: window.tmdbtv };
  const owners = await deps.owners(show, season);
  const eligible = new Set(owners
    .filter((owner) => TV_TYPES.has(owner.mediaType ?? ""))
    .map((owner) => owner.entry));
  if (eligible.size !== 1 || !eligible.has(bundle.entry)) return null;

  const aliases = singleAliasMap(bundle);
  if (!aliases) return null;
  // The native stream may be Kitsu while the original row is MAL/IMDb/TMDB.
  const ownedKitsu = aliases.kitsu;
  if (nativeStream && ownedKitsu !== nativeId) return null;
  const entryId = ownedKitsu ?? nativeId;
  const catalogIds = [
    ...(window.tmdbtv != null ? [`tmdb:tv:${window.tmdbtv}`] : []),
    ...(/^tt[1-9]\d*$/.test(src.meta.id) ? [src.meta.id] : []),
  ];
  const work: TrackerWork = {
    entryId,
    entryEpisode: number,
    aliases,
    catalogIds,
    evidence: "pack+window",
  };
  const episode: PlayEpisode = {
    ...ep,
    sourceMetaId: entryId,
    ...(nativeStream ? { kitsuStreamId: ep.kitsuStreamId } : {}),
  };

  // Direct catalog targets are allowed only when entry numbers and the
  // provider's season/episode are identical. Otherwise existing provider
  // resolution handles the conversion, without a guessed write.
  const providerNumber = ep.imdbEpisode ?? ep.episode;
  const tmdbMatch = window.tmdbSeason === season &&
    (window.tmdbOffset == null || window.tmdbOffset === 0) &&
    number === providerNumber;
  const tvdbMatch = window.tvdbSeason === season &&
    (window.tvdbOffset == null || window.tvdbOffset === 0) &&
    number === providerNumber;
  const traktTarget: TraktTarget | null = tvdbMatch && window.tvdb != null
    ? { kind: "episode", show: { ids: { tvdb: window.tvdb } }, season, number: providerNumber }
    : null;
  const pmdbTarget: PmdbTarget | null = tmdbMatch && window.tmdbtv != null
    ? { tmdb_id: window.tmdbtv, media_type: "tv", season, episode: providerNumber }
    : null;
  return { work, episode, traktTarget, pmdbTarget };
}

/** Provider-native episode progress. No IMDb/TMDB franchise ids go to MAL or AniList. */
export function nativeLiveProgressTargets(proof: LiveAnimeProof): {
  source: string;
  episode: number;
  anilist: string;
  mal: string;
} {
  const source = proof.work.entryId;
  return {
    source,
    episode: proof.work.entryEpisode,
    anilist: proof.work.aliases?.anilist ?? source,
    mal: proof.work.aliases?.mal ?? source,
  };
}
