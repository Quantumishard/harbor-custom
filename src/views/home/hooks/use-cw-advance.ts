import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchEpisodeList, nextUnwatchedAfter } from "@/lib/series-episodes";
import { fetchCwNextAiring } from "@/lib/anilist/cw-next-airing";
import type { Meta } from "@/lib/cinemeta";
import type { PlayEpisode } from "@/lib/view";
import { getEpisodeProgress } from "@/lib/episode-progress";
import {
  loadSimklProgress,
  simklWatchedForId,
  statusForId,
  type SimklProgress,
  type WatchlistStatus,
} from "@/lib/simkl/list-status";
import { getSession as getSimklSession, subscribeSession } from "@/lib/simkl/session";
import { manualWatchedState } from "@/lib/manual-watched";
import {
  isAnimeCwItem,
  isCwMember,
  isCwDisplayReady,
  libraryMetaType,
  resolvedEpisodeCoords,
  type LibraryItem,
} from "@/lib/stremio";
import { isEpisodeHidden } from "@/lib/hidden-episodes";
import {
  cwEpisodeListCacheToken,
  cwEpisodeListCacheTtl,
  fetchCachedCwEpisodeList,
} from "@/lib/cw-episode-list-cache";
import {
  clearResurfaceCache,
  isNextAired,
  resurfaceCandidates,
  staleCwIds,
  type AnimeMode,
  type ResurfaceTarget,
} from "@/lib/cw-resurface";
import { lastPlayedEpisode, readResumeEntry } from "@/lib/resume";
import { getViewedSeason } from "@/lib/season-view-pref";
import { getAnimeCwId } from "@/lib/anime-cw-ids";
import { resolveTrackerAnimeEntryStrict } from "@/lib/anime-tracker-entry";
import {
  preferredMixedSeason,
  providerAliasCoords,
  resolveEffectiveEpisode,
} from "@/lib/cw-anime-episode";
import { isSplitFranchiseKitsu } from "@/lib/providers/anime-franchise-root";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { franchiseDedupKey } from "@/lib/providers/jikan";
import { useSettings } from "@/lib/settings";
import { isCwDismissed, useCwDismissVersion } from "@/lib/cw-dismiss";
import { anyProfileSharesStremioWith, stremioSourceProfileId, useProfiles } from "@/lib/profiles";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { getNuvioActiveSlot } from "@/lib/active-profile-id";
import { getNuvioAccountId } from "@/lib/nuvio/nuvio-client";
import { listLocalCw, localCwSourceEnabled } from "@/lib/local-cw";
import { localToLibraryItem } from "@/lib/continue-watching";
import {
  cwAnimeIdentityKey,
  cwWarmIdentityKey,
  dedupeAnimeCw,
  warmCwAnimeIdentities,
} from "@/lib/cw-anime-identity";
import { dedupeCwItems } from "@/lib/cw-dedupe";
import { sortCwFinal } from "@/lib/cw-order";
import {
  cwDisplayInputFingerprint,
  cwDisplayOwnerKey,
  restoreCwDisplaySnapshot,
  saveCwDisplaySnapshot,
} from "@/lib/cw-display-snapshot";
import {
  cwAdvanceCandidates,
  cwAdvanceComplete,
  cwAdvanceOutcome,
  cwAdvanceStart,
  cwAdvanceSuperseded,
  cwAdvanceTerminate,
  cwAnimeWarmEnd,
  cwAnimeWarmStart,
  cwResurfaceComplete,
  cwResurfaceStart,
  cwStaleComplete,
  cwStaleStart,
  cwStateCommit,
} from "@/lib/cw-instrumentation";
import { cwNextDisplayCoords } from "@/lib/cw-next-display";
import { seasonIndex } from "@/lib/season-index";

const FINISHED_RATIO = 0.9;
const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;
// The trace's 10 s window is diagnostic only. The worker needs its own deadline
// so one hanging request cannot hold the single-flight slot forever.
const WORKER_TIMEOUT_MS = 30_000;
// Independent episode-list requests overlap up to this many, so a pass does not
// wait a full provider round trip per card. Kitsu keeps its own queue limit.
const LIST_CONCURRENCY = 3;
// A resolver outage is retried later, not on every pass. The card stays put
// meanwhile: this is a cooldown, never an "unavailable means finished" answer.
const ANIME_FAILURE_RETRY_MS = 60_000;

type AdvanceOwner = {
  enabled: boolean;
  privacyOwner: string | null;
  profileId: string | null;
  stremioSourceId: string | null;
  stremioAuthKey: string | null;
  traktIdentity: string;
  simklSession: unknown;
  simklEnabled: boolean;
  accountProvider: string;
  nuvioSlot: number;
  nuvioAccountId: string | null;
  tmdbKey: string;
  sources: string;
};

type AdvanceContext = {
  passId: number | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isSuperseded: () => boolean;
  complete: () => void;
  supersede: () => void;
  markCommit: () => void;
};

type AdvanceRun = (ctx: AdvanceContext) => Promise<void>;

type ActiveAdvance = {
  owner: AdvanceOwner;
  passId: number | null;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  superseded: boolean;
};

type PendingAdvance = { run: AdvanceRun; owner: AdvanceOwner };

type ListFetch = { ok: boolean; eps: PlayEpisode[]; aborted: boolean };

/** What a completed pass decided for one CW entry, reusable while it is unchanged. */
type PassDecision = { item: LibraryItem; next?: LibraryItem; remove?: boolean };

function sameOwner(a: AdvanceOwner, b: AdvanceOwner): boolean {
  return (
    a.enabled === b.enabled &&
    a.privacyOwner === b.privacyOwner &&
    a.profileId === b.profileId &&
    a.stremioSourceId === b.stremioSourceId &&
    a.stremioAuthKey === b.stremioAuthKey &&
    a.traktIdentity === b.traktIdentity &&
    a.simklSession === b.simklSession &&
    a.simklEnabled === b.simklEnabled &&
    a.accountProvider === b.accountProvider &&
    a.nuvioSlot === b.nuvioSlot &&
    a.nuvioAccountId === b.nuvioAccountId &&
    a.tmdbKey === b.tmdbKey &&
    a.sources === b.sources
  );
}

const EMPTY_TRAKT_WATCHED: Set<string> = new Set();
const EMPTY_SIMKL_WATCHED: Map<string, Set<string>> = new Map();
const EMPTY_ANILIST_WATCHED: Map<string, Set<string>> = new Map();
const EMPTY_SIMKL_STATUS: Map<string, WatchlistStatus> = new Map();
const EMPTY_LIBRARY: LibraryItem[] = [];

function isFinishedSeries(i: LibraryItem): boolean {
  if (i.type !== "series" || !i.state) return false;
  const dur = i.state.duration ?? 0;
  const off = i.state.timeOffset ?? 0;
  if ((i.state.flaggedWatched ?? 0) > 0) return dur <= 0 || off / dur >= FINISHED_RATIO;
  return dur > 0 && off / dur >= FINISHED_RATIO;
}

function currentEpisode(i: LibraryItem): { season: number; episode: number } | null {
  return resolvedEpisodeCoords(i);
}

/** A locally completed checkpoint is input for advancement, not a resume card.
 * Keep synthetic external-provider checkpoints visible on lookup failure: their
 * zero-duration "watched" marker is not a local playback completion proof.
 * A verified next episode resets watched state; airing timers stay visible.
 *
 * `unresolved` carries cards whose next-episode lookup failed in the current
 * pass. Their finished card is the last good state and must stay readable until
 * a later pass resolves or verifies removal. */
function isPlayableCwDisplay(
  i: LibraryItem,
  advancementEnabled: boolean,
  unresolved?: ReadonlySet<string>,
): boolean {
  if (!isCwDisplayReady(i)) return false;
  if (i.caughtUp || unresolved?.has(i._id)) return true;
  if (
    !advancementEnabled ||
    i.type !== "series" ||
    i.external ||
    i.waitingForAir ||
    !isFinishedSeries(i)
  )
    return true;
  const cur = currentEpisode(i);
  return cur != null && manualWatchedState(i._id, cur.season, cur.episode) === false;
}

function scopedSplitItem(id: string): boolean {
  return isSplitFranchiseKitsu(parseKitsuId(id) ?? parseKitsuId(getAnimeCwId(id) ?? ""));
}

// A detected-anime row can finish an episode its provider (Cinemeta/TMDB) list
// does not even contain — a sequel season the provider has not filled in yet,
// so the row looks unplaceable and finished-with-nothing-next. The played anime
// entry (Kitsu, with AniZip air dates) knows the episode that actually follows.
function animeStreamAnchor(item: LibraryItem): { animeId: string; episode: number } | null {
  const m = /^(kitsu|mal|anilist|anidb):(\d+):(\d+)$/.exec(item.state?.video_id ?? "");
  return m ? { animeId: `${m[1]}:${m[2]}`, episode: Number(m[3]) } : null;
}

async function animeEntryFollowUp(
  item: LibraryItem,
  from: { season: number; episode: number },
  tmdbKey: string,
  watched: (season: number, episode: number) => boolean,
  skip: ((season: number, episode: number) => boolean) | undefined,
  listCache: Map<string, PlayEpisode[]>,
  signal: AbortSignal,
  isCurrent: () => boolean,
  failureMemo: Map<string, number>,
): Promise<PlayEpisode | null> {
  const stream = animeStreamAnchor(item);
  // The played entry recorded at playback time (recordAnimePlayId) is the
  // resolved anime entry for this row; a fresh mapping lookup would fail for
  // exactly the brand-new seasons this fallback exists for.
  let animeId = stream?.animeId ?? getAnimeCwId(item._id);
  const entryList = async (id: string): Promise<PlayEpisode[]> => {
    const cacheKey = `anime-entry:${id}`;
    const cached = listCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let fetched: PlayEpisode[] = [];
    try {
      fetched = await fetchEpisodeList({ id, type: "series", name: item.name } as Meta, {
        tmdbKey,
        signal,
        requireComplete: true,
      });
      // An unabortable provider can resolve after an owner switch; never let
      // that result populate the shared episode-list cache.
      if (!isCurrent() || signal.aborted) return [];
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return [];
      // An unavailable sequel list must not be read as "this show has no more
      // episodes": that is what removes a card. Let the caller skip the card.
      throw error;
    }
    if (fetched.length > 0) listCache.set(cacheKey, fetched);
    return fetched;
  };
  let list = animeId ? await entryList(animeId) : [];
  // The recorded entry can be an earlier cour than the season this row finished,
  // or there may be no recorded entry at all (a catalog row the app never
  // flagged as anime). Its episodes then declare that cour's provider season,
  // so projecting the finished episode into it returns an episode of the wrong
  // season. Walk to the cour that actually aired `from.season` and use its list.
  let walked = false;
  const coveredSeasons = new Set(
    list.map((v) => v.imdbSeason).filter((n): n is number => typeof n === "number"),
  );
  const entryMissesSeason =
    list.length === 0 || (coveredSeasons.size > 0 && !coveredSeasons.has(from.season));
  if (entryMissesSeason) {
    // A resolver outage is cached by the provider for minutes; retrying it every
    // pass only re-raises the same failure. Key by checkpoint so real progress
    // still gets its own attempt. Keep the card and retry later.
    const failureKey = `${item._id}:${from.season}:${from.episode}`;
    if ((failureMemo.get(failureKey) ?? 0) > Date.now())
      throw new Error("anime-resolution-cooldown");
    const resolved = await resolveTrackerAnimeEntryStrict(item._id, {
      season: from.season,
      episode: from.episode,
    }).catch((error: unknown) => {
      if ((error as { name?: string })?.name === "AbortError") return null;
      // A pass that is already obsolete must not memoize a cooldown that the
      // replacement pass (or the next owner) will then obey.
      if (isCurrent() && !signal.aborted)
        failureMemo.set(failureKey, Date.now() + ANIME_FAILURE_RETRY_MS);
      throw error;
    });
    if (!isCurrent() || signal.aborted) return null;
    if (resolved && resolved.id !== animeId) {
      const nextList = await entryList(resolved.id);
      if (nextList.length > 0) {
        animeId = resolved.id;
        list = nextList;
        walked = true;
      }
    }
  }
  if (!animeId || list.length === 0) return null;
  const inList = (s: number, e: number) => list.some((v) => v.season === s && v.episode === e);
  let pos: { season: number; episode: number } | null = null;
  if (stream && animeId === stream.animeId && inList(1, stream.episode)) {
    pos = { season: 1, episode: stream.episode };
  } else if (inList(from.season, from.episode)) {
    pos = { season: from.season, episode: from.episode };
  } else {
    const mapped =
      list.find((v) => v.imdbSeason === from.season && v.imdbEpisode === from.episode) ??
      list.find((v) => v.absoluteNumber != null && v.absoluteNumber === from.episode) ??
      // A flat sequel restarts at episode 1, so its entry-relative position is
      // the provider episode. Only used after the franchise walk selected it.
      (walked && inList(1, from.episode) ? { season: 1, episode: from.episode } : undefined);
    if (mapped) pos = { season: mapped.season, episode: mapped.episode };
  }
  if (!pos) return null;
  const idx = list.findIndex((v) => v.season === pos.season && v.episode === pos.episode);
  for (let k = idx + 1; k < list.length; k++) {
    const v = list[k];
    // The entry is the cour that aired `from`'s season, so an entry episode
    // without its own IMDb mapping is evaluated in provider space at
    // (from.season, entry number) — never at entry-relative season coords,
    // which would collide with earlier seasons of the same show.
    const season = v.imdbSeason ?? from.season;
    // The entry-relative episode is the provider episode here; the franchise
    // absolute number is a different coordinate and must never stand in for it.
    const episode = v.imdbEpisode ?? v.episode;
    if (skip?.(season, episode)) continue;
    if (watched(season, episode)) continue;
    return { ...v, season, episode };
  }
  return null;
}

export function shouldDropFinished(
  list: PlayEpisode[],
  fetchOk: boolean,
  state: { duration?: number; timeOffset?: number } | undefined,
  animeMode: AnimeMode,
  effCur: { season: number; episode: number },
  nextEp: PlayEpisode | null | undefined,
  hideCaughtUp = false,
): boolean {
  if (!fetchOk || list.length === 0) return false;
  const finaleEp = list[list.length - 1];
  const dur = state?.duration ?? 0;
  const off = state?.timeOffset ?? 0;
  const midEpisode = off > 0 && (dur <= 0 || off / dur < FINISHED_RATIO);
  const freshMidResume =
    animeMode === "only" && midEpisode && finaleEp != null && effCur.episode < finaleEp.episode;
  if (freshMidResume || midEpisode) return false;
  return hideCaughtUp || !nextEp;
}

function clearTimerFlags(item: LibraryItem): LibraryItem {
  return {
    ...item,
    caughtUp: undefined,
    waitingForAir: undefined,
    nextAirDate: undefined,
    keptForTimer: undefined,
  } as LibraryItem;
}

// Providers can list a future season's first episode before that season is
// announced. With no air date it is a placeholder, not the next watchable
// episode. Same-season entries without dates keep the old behavior because
// providers often omit dates there.
function isUnannouncedSeason(
  nextEp: PlayEpisode,
  isAnime: boolean,
  currentSeason: number,
): boolean {
  return !isAnime && !nextEp.airDate && nextEp.season > currentSeason;
}

function nextEpAired(
  list: PlayEpisode[],
  nextEp: PlayEpisode,
  isAnime: boolean,
  currentSeason: number,
): boolean {
  if (isUnannouncedSeason(nextEp, isAnime, currentSeason)) return false;
  if (isNextAired(isAnime, nextEp.airDate)) return true;
  if (!isAnime || nextEp.airDate) return false;
  const now = Date.now();
  let boundary = -1;
  for (let k = 0; k < list.length; k++) {
    const raw = list[k].airDate;
    const t = raw ? Date.parse(raw) : NaN;
    if (Number.isFinite(t) && t <= now) boundary = k;
  }
  if (boundary < 0) return false;
  const idx = list.findIndex((e) => e.season === nextEp.season && e.episode === nextEp.episode);
  return idx >= 0 && idx <= boundary;
}

function watchedPredicate(
  i: LibraryItem,
  cur: { season: number; episode: number },
  traktWatched: Set<string>,
  simklWatched: Map<string, Set<string>>,
  anilistWatched: Map<string, Set<string>>,
  simklStatus: Map<string, WatchlistStatus>,
  privateOnly = false,
) {
  const finished = isFinishedSeries(i);
  if (privateOnly) {
    return (season: number, episode: number) =>
      season === cur.season && episode === cur.episode && finished;
  }
  const traktImdb = i._id.startsWith("tt")
    ? i._id
    : i.state?.video_id && i.state.video_id.startsWith("tt")
      ? i.state.video_id.split(":")[0]
      : null;
  const cleanId = i._id.replace(/^(series|movie|tmdb):/, "");
  const altIds = [traktImdb, cleanId, `tmdb:${cleanId}`, `series:${cleanId}`].filter(
    (x): x is string => !!x && x !== i._id,
  );
  const simklSet = simklWatchedForId(simklWatched, i._id);
  const aniSet = anilistWatched.get(i._id);
  const simklCompleted = statusForId(simklStatus, i._id) === "completed";
  return (season: number, episode: number): boolean => {
    if (manualWatchedState(i._id, season, episode, altIds) === false) return false;
    const prog = getEpisodeProgress(
      i._id,
      season,
      episode,
      null,
      traktImdb,
      traktWatched,
      undefined,
      aniSet,
      simklSet,
    );
    if (prog.watched || manualWatchedState(i._id, season, episode, altIds) === true) return true;
    if (season === cur.season && episode === cur.episode) return finished;
    if (simklCompleted && (season < cur.season || (season === cur.season && episode < cur.episode)))
      return true;
    const isShowWatched =
      finished ||
      (i.state?.flaggedWatched ?? 0) > 0 ||
      manualWatchedState(i._id, cur.season, cur.episode, altIds) === true;
    if (isShowWatched && (season < cur.season || (season === cur.season && episode <= cur.episode)))
      return true;
    return false;
  };
}

function sameState(a?: LibraryItem["state"], b?: LibraryItem["state"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.timeOffset === b.timeOffset &&
    a.duration === b.duration &&
    a.season === b.season &&
    a.episode === b.episode &&
    a.timeWatched === b.timeWatched &&
    a.flaggedWatched === b.flaggedWatched &&
    a.timesWatched === b.timesWatched &&
    a.watched === b.watched &&
    a.video_id === b.video_id &&
    a.lastWatched === b.lastWatched
  );
}

function sameStringList(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameProviderPlaybackIds(
  a?: Partial<Record<"trakt" | "simkl" | "publicmetadb", string>>,
  b?: Partial<Record<"trakt" | "simkl" | "publicmetadb", string>>,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.trakt === b.trakt && a.simkl === b.simkl && a.publicmetadb === b.publicmetadb;
}

/** One level only: source records kept for CW dedupe and provider dismissal. */
function sameCwMember(a: LibraryItem, b: LibraryItem): boolean {
  if (a === b) return true;
  return (
    a._id === b._id &&
    a.type === b.type &&
    a.name === b.name &&
    a.external === b.external &&
    // `local` decides dismissal scope when no external provider is present.
    a.local === b.local &&
    a.manualWatched === b.manualWatched &&
    a.isAnime === b.isAnime &&
    a.upNext === b.upNext &&
    a.caughtUp === b.caughtUp &&
    a.waitingForAir === b.waitingForAir &&
    a.nextAirDate === b.nextAirDate &&
    a.removed === b.removed &&
    a.temp === b.temp &&
    a._ctime === b._ctime &&
    a._mtime === b._mtime &&
    sameState(a.state, b.state) &&
    sameStringList(a.altIds, b.altIds) &&
    sameProviderPlaybackIds(a.providerPlaybackIds, b.providerPlaybackIds) &&
    (a as Record<string, unknown>).keptForTimer === (b as Record<string, unknown>).keptForTimer
  );
}

function sameMembers(a?: LibraryItem[], b?: LibraryItem[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameCwMember(a[i], b[i])) return false;
  return true;
}

/**
 * Semantic equality for a CW card. Reference equality made every pass look
 * changed, which published state and re-armed advancement for no reason.
 * Every field that changes what CW renders or does must be compared here.
 */
function sameCwItem(a: LibraryItem, b: LibraryItem): boolean {
  if (a === b) return true;
  if (
    a._id !== b._id ||
    a.type !== b.type ||
    a.name !== b.name ||
    a.poster !== b.poster ||
    a.background !== b.background ||
    a.removed !== b.removed ||
    a.temp !== b.temp ||
    a._ctime !== b._ctime ||
    a._mtime !== b._mtime ||
    a.external !== b.external ||
    a.isAnime !== b.isAnime ||
    a.upNext !== b.upNext ||
    a.caughtUp !== b.caughtUp ||
    a.waitingForAir !== b.waitingForAir ||
    a.nextAirDate !== b.nextAirDate ||
    a.local !== b.local ||
    a.manualWatched !== b.manualWatched ||
    !sameProviderPlaybackIds(a.providerPlaybackIds, b.providerPlaybackIds) ||
    !sameState(a.state, b.state) ||
    !sameStringList(a.altIds, b.altIds) ||
    !sameMembers(a.cwMembers, b.cwMembers)
  )
    return false;
  // Timer-only flags live outside the typed item and still affect the row.
  return (
    (a as Record<string, unknown>).keptForTimer === (b as Record<string, unknown>).keptForTimer
  );
}

function sameMap(a: Map<string, LibraryItem>, b: Map<string, LibraryItem>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const other = b.get(k);
    if (!other || !sameCwItem(v, other)) return false;
  }
  return true;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function sameList(a: LibraryItem[], b: LibraryItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameCwItem(a[i], b[i])) return false;
  return true;
}

export function useCwAdvance(
  items: LibraryItem[],
  tmdbKey: string,
  enabled: boolean,
  library?: LibraryItem[],
  animeMode: AnimeMode = "all",
  watchedVersion = 0,
  traktWatched: Set<string> = EMPTY_TRAKT_WATCHED,
  simklWatched: Map<string, Set<string>> = EMPTY_SIMKL_WATCHED,
  anilistWatched: Map<string, Set<string>> = EMPTY_ANILIST_WATCHED,
  simklStatus: Map<string, WatchlistStatus> = EMPTY_SIMKL_STATUS,
  animeVersion = 0,
  episodeHiding = false,
  animeCwEnd: "hide" | "timer" = "hide",
  progressPool: LibraryItem[] = EMPTY_LIBRARY,
): LibraryItem[] {
  const dismissVersion = useCwDismissVersion();
  const { settings } = useSettings();
  const hideCaughtUp = settings.cwHideCaughtUp;
  // Resurface decisions are keyed by these settings; a change must not reuse a
  // timer, caught-up or negative decision computed under the previous values.
  const resurfaceCacheKey = [
    hideCaughtUp,
    settings.animeCwEnd,
    settings.addonOnlyMetadata,
    JSON.stringify(settings.metadataSources?.episodes ?? null),
    JSON.stringify(settings.metadataAddonOrder ?? null),
    settings.tmdbKey ?? "",
    settings.tvdbKey ?? "",
    settings.tvdbSeasonType ?? "",
  ].join("|");
  useEffect(() => {
    clearResurfaceCache();
  }, [resurfaceCacheKey]);
  const { activeProfile, profiles } = useProfiles();
  const privacyOwner =
    settings.cwPerProfile && anyProfileSharesStremioWith(activeProfile, profiles)
      ? (activeProfile?.id ?? null)
      : null;
  const simklSession = useSyncExternalStore(subscribeSession, getSimklSession, getSimklSession);
  const simklEnabled = settings.cwSources.simkl;
  const profileId = activeProfile?.id ?? null;
  const stremioSourceId = stremioSourceProfileId(activeProfile, profiles);
  const stremioAuthKey = readActiveStremioAuthKey();
  const nuvioSlot = getNuvioActiveSlot();
  // Same slot can be a different Nuvio account after a re-login; it owns CW data.
  const nuvioAccountId = getNuvioAccountId();
  const traktIdentity = `${settings.traktUsername ?? ""}|${settings.traktAccessToken ?? ""}`;
  const sourceKey = [
    settings.cwSources.library,
    settings.cwSources.trakt,
    settings.cwSources.simkl,
    settings.cwSources.local,
    settings.cwSources.publicmetadb,
  ]
    .map((value) => (value ? "1" : "0"))
    .join("");
  const [resolvedOwner, setResolvedOwner] = useState({
    privacyOwner,
    profileId,
    stremioSourceId,
    stremioAuthKey,
    traktIdentity,
    nuvioSlot,
    nuvioAccountId,
    accountProvider: settings.accountProvider,
    tmdbKey,
    sources: sourceKey,
    simklSession,
    simklEnabled,
  });
  const [advanced, setAdvanced] = useState<Map<string, LibraryItem>>(new Map());
  const [extra, setExtra] = useState<LibraryItem[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  // Finished cards whose next-episode lookup failed in the latest pass. Bypassing
  // the finished-card hide for them keeps the last good card readable on outage.
  const [displayFailures, setDisplayFailures] = useState<Set<string>>(new Set());
  // A stored presentation is provisional until this owner has completed a live
  // pass. Keep it distinct from provider progress and deletion ownership.
  const displayScope = cwDisplayOwnerKey([
    privacyOwner,
    profileId,
    stremioSourceId,
    stremioAuthKey,
    traktIdentity,
    nuvioSlot,
    nuvioAccountId,
    settings.accountProvider,
    tmdbKey,
    sourceKey,
    simklSession,
    simklEnabled,
    animeMode,
    episodeHiding,
    hideCaughtUp,
    animeCwEnd,
  ]);
  // Episode metadata has a different lifetime from CW display decisions:
  // tracker refresh sessions, hide-mode settings and watched progress must
  // not cause another episode-list download for the same source account.
  const episodeListScope = cwDisplayOwnerKey([
    privacyOwner,
    profileId,
    stremioSourceId,
    stremioAuthKey,
    nuvioSlot,
    nuvioAccountId,
    settings.accountProvider,
  ]);
  const [liveDisplayScope, setLiveDisplayScope] = useState<string | null>(null);
  const [verifiedInputs, setVerifiedInputs] = useState<{
    scope: string;
    fingerprints: Map<string, string>;
  }>({ scope: "", fingerprints: new Map() });
  const restoredDisplay = useMemo(
    () => restoreCwDisplaySnapshot(displayScope, items, { library: library ?? items }),
    [displayScope, items, library],
  );
  // A successful live pass for one card must not discard another card's
  // verified display while its provider source or episode list is still loading.
  // Live results always win. A source-level proof stops applying once the live
  // worker has definitively evaluated that same checkpoint.
  const hasLiveDisplay =
    liveDisplayScope === displayScope || advanced.size > 0 || removed.size > 0 || extra.length > 0;
  const displayAdvanced = useMemo(() => {
    if (!hasLiveDisplay) return restoredDisplay.advanced;
    if (restoredDisplay.advanced.size === 0) return advanced;
    const current = new Map(advanced);
    const verified = verifiedInputs.scope === displayScope ? verifiedInputs.fingerprints : null;
    for (const item of items) {
      // Do not revive a completed temporary source ahead of the stale-copy
      // reconciliation (the Phase 4C JoJo duplicate regression).
      if (item.removed && item.temp) continue;
      if (current.has(item._id) || !restoredDisplay.advanced.has(item._id)) continue;
      if (verified?.get(item._id) === cwDisplayInputFingerprint(item)) continue;
      current.set(item._id, restoredDisplay.advanced.get(item._id)!);
    }
    return current;
  }, [hasLiveDisplay, advanced, restoredDisplay.advanced, verifiedInputs, items, displayScope]);
  const displayRemoved = hasLiveDisplay ? removed : restoredDisplay.removed;
  const displayExtra = hasLiveDisplay ? extra : restoredDisplay.extra;
  const unresolvedDisplayIds = displayFailures;
  const listCacheRef = useRef<Map<string, PlayEpisode[]>>(new Map());
  const listExpiryRef = useRef(new Map<string, number>());
  const listTokenRef = useRef<string | null>(null);
  const stateCommitPassRef = useRef<ActiveAdvance | null>(null);
  const advancedRef = useRef(advanced);
  const extraRef = useRef(extra);
  const removedRef = useRef(removed);
  const displayFailuresRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    advancedRef.current = advanced;
  }, [advanced]);
  useEffect(() => {
    extraRef.current = extra;
  }, [extra]);
  useEffect(() => {
    removedRef.current = removed;
  }, [removed]);
  useEffect(() => {
    displayFailuresRef.current = displayFailures;
  }, [displayFailures]);

  const [airTick, setAirTick] = useState(0);
  const airTimerRef = useRef<number | null>(null);
  const owner: AdvanceOwner = {
    enabled,
    privacyOwner,
    profileId,
    stremioSourceId,
    stremioAuthKey,
    traktIdentity,
    simklSession,
    simklEnabled,
    accountProvider: settings.accountProvider,
    nuvioSlot,
    nuvioAccountId,
    tmdbKey,
    sources: sourceKey,
  };
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const cacheOwnerRef = useRef<AdvanceOwner | null>(null);
  const activeAdvanceRef = useRef<ActiveAdvance | null>(null);
  const pendingAdvanceRef = useRef<PendingAdvance | null>(null);
  // Owner-scoped request plumbing: one abort scope for the owner, one shared
  // in-flight slot per title, and a resolver cooldown per title.
  const ownerAbortRef = useRef<AbortController | null>(null);
  const listInflightRef = useRef(new Map<string, Promise<ListFetch>>());
  const animeFailureRef = useRef(new Map<string, number>());
  const lastPassRef = useRef<{ inputs: unknown[]; decisions: Map<string, PassDecision> } | null>(
    null,
  );

  function ownerSignal(): AbortSignal {
    ownerAbortRef.current ??= new AbortController();
    return ownerAbortRef.current.signal;
  }

  function dropOwnerWork(): void {
    ownerAbortRef.current?.abort();
    ownerAbortRef.current = null;
    // Completed lists can come from a different metadata configuration; never
    // hand one owner's result to the next.
    listCacheRef.current.clear();
    listExpiryRef.current.clear();
    listInflightRef.current.clear();
    // Replace, never share: a resolver that started under the previous owner
    // may still fail, and must not write its cooldown into this owner's map.
    animeFailureRef.current = new Map();
    lastPassRef.current = null;
  }

  function fetchAdvanceList(item: LibraryItem): Promise<ListFetch> {
    const token = cwEpisodeListCacheToken();
    if (listTokenRef.current !== token) {
      // Disk cache clearing or metadata-setting changes invalidate the live
      // owner's warm lists too; never reuse an old provider configuration.
      listCacheRef.current.clear();
      listExpiryRef.current.clear();
      listInflightRef.current.clear();
      listTokenRef.current = token;
      lastPassRef.current = null;
    }
    const cached = listCacheRef.current.get(item._id);
    if (cached && (listExpiryRef.current.get(item._id) ?? 0) > Date.now())
      return Promise.resolve({ ok: true, eps: cached, aborted: false });
    listCacheRef.current.delete(item._id);
    listExpiryRef.current.delete(item._id);
    // A superseded pass must not make the following pass fetch the same list
    // again: the request belongs to the owner, not to one pass.
    const shared = listInflightRef.current.get(item._id);
    if (shared) return shared;
    const meta: Meta = {
      id: item._id,
      type: libraryMetaType(item.type),
      name: item.name,
      poster: item.poster,
      background: item.background,
    };
    const requestSignal = ownerSignal();
    const pending = fetchCachedCwEpisodeList(
      meta,
      {
        tmdbKey,
        signal: requestSignal,
      },
      episodeListScope,
    )
      .then((eps): ListFetch => {
        if (requestSignal.aborted || token !== cwEpisodeListCacheToken())
          return { ok: false, eps: [], aborted: true };
        if (eps.length > 0) {
          listCacheRef.current.set(item._id, eps);
          listExpiryRef.current.set(item._id, Date.now() + cwEpisodeListCacheTtl(eps));
        }
        return { ok: true, eps, aborted: false };
      })
      .catch((error: unknown): ListFetch => {
        const aborted = (error as { name?: string })?.name === "AbortError";
        return { ok: false, eps: [], aborted };
      })
      .finally(() => {
        // Only remove our own slot: an older request must not unhook the
        // replacement owner's in-flight entry for the same title.
        if (listInflightRef.current.get(item._id) === pending)
          listInflightRef.current.delete(item._id);
      });
    listInflightRef.current.set(item._id, pending);
    return pending;
  }

  /** Warm independent episode lists with bounded concurrency before deciding. */
  async function prefetchAdvanceLists(
    pending: LibraryItem[],
    passSignal: AbortSignal,
    results: Map<string, ListFetch>,
    isSuperseded: () => boolean,
  ): Promise<void> {
    const queue = pending.filter(
      (item) => (listExpiryRef.current.get(item._id) ?? 0) <= Date.now() && !results.has(item._id),
    );
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        // A superseded pass keeps its already-started requests (the trailing
        // pass can reuse them) but must not queue more work on stale inputs.
        if (passSignal.aborted || isSuperseded()) return;
        const item = queue[cursor++];
        const result = await fetchAdvanceList(item);
        if (!passSignal.aborted) results.set(item._id, result);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LIST_CONCURRENCY, queue.length) }, () => worker()),
    );
  }

  function finishAdvance(
    active: ActiveAdvance,
    outcome: "complete" | "cancel" | "failure" | "timeout" | "superseded",
  ): void {
    if (active.closed) return;
    active.closed = true;
    if (active.timer != null) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    if (outcome === "complete") cwAdvanceComplete(active.passId);
    else {
      if (stateCommitPassRef.current === active) stateCommitPassRef.current = null;
      if (outcome === "superseded") cwAdvanceSuperseded(active.passId);
      else cwAdvanceTerminate(active.passId, outcome === "cancel" ? "cancelled" : outcome);
    }
    if (activeAdvanceRef.current !== active) return;
    activeAdvanceRef.current = null;
    const pending = pendingAdvanceRef.current;
    pendingAdvanceRef.current = null;
    if (pending && sameOwner(pending.owner, ownerRef.current))
      startAdvance(pending.run, pending.owner);
  }

  function startAdvance(run: AdvanceRun, runOwner: AdvanceOwner): void {
    if (cacheOwnerRef.current && !sameOwner(cacheOwnerRef.current, runOwner)) {
      dropOwnerWork();
      const emptyMap = new Map<string, LibraryItem>();
      const emptyExtra: LibraryItem[] = [];
      const emptyRemoved = new Set<string>();
      // Reset the comparison refs in the same turn as the state. React may not
      // have committed the reset before this pass finishes, and comparing
      // against the previous owner's results would then suppress publication.
      advancedRef.current = emptyMap;
      extraRef.current = emptyExtra;
      removedRef.current = emptyRemoved;
      setAdvanced(emptyMap);
      setExtra(emptyExtra);
      setRemoved(emptyRemoved);
    }
    cacheOwnerRef.current = runOwner;
    const controller = new AbortController();
    const passId = cwAdvanceStart();
    const active: ActiveAdvance = {
      owner: runOwner,
      passId,
      controller,
      timer: null,
      closed: false,
      superseded: false,
    };
    active.timer = setTimeout(() => {
      if (active.closed) return;
      controller.abort();
      finishAdvance(active, "timeout");
    }, WORKER_TIMEOUT_MS);
    // Node's timer object would otherwise keep tests and tooling alive.
    (active.timer as unknown as { unref?: () => void }).unref?.();
    activeAdvanceRef.current = active;
    void run({
      passId,
      signal: controller.signal,
      isCurrent: () =>
        activeAdvanceRef.current === active &&
        !active.closed &&
        !controller.signal.aborted &&
        sameOwner(active.owner, ownerRef.current),
      isSuperseded: () => active.superseded,
      complete: () => finishAdvance(active, "complete"),
      supersede: () => finishAdvance(active, "superseded"),
      markCommit: () => {
        stateCommitPassRef.current = active;
      },
    }).catch(() => {
      if (!active.closed) finishAdvance(active, "failure");
    });
  }

  function requestAdvance(run: AdvanceRun, runOwner: AdvanceOwner): void {
    const active = activeAdvanceRef.current;
    if (active && !active.closed) {
      if (sameOwner(active.owner, runOwner)) {
        active.superseded = true;
        pendingAdvanceRef.current = { run, owner: runOwner };
        return;
      }
      active.controller.abort();
      finishAdvance(active, "cancel");
    }
    pendingAdvanceRef.current = null;
    startAdvance(run, runOwner);
  }

  function cancelAdvance(): void {
    pendingAdvanceRef.current = null;
    dropOwnerWork();
    const active = activeAdvanceRef.current;
    if (active) {
      active.controller.abort();
      finishAdvance(active, "cancel");
    }
    if (airTimerRef.current !== null) {
      window.clearTimeout(airTimerRef.current);
      airTimerRef.current = null;
    }
  }

  const [remoteProgress, setRemoteProgress] = useState<{
    profileId: string | null;
    session: typeof simklSession;
    data: SimklProgress;
  } | null>(null);
  const warmItems = useMemo(
    () =>
      [...items.map((item) => displayAdvanced.get(item._id) ?? item), ...displayExtra].filter(
        (item) => isCwMember(item) && !displayRemoved.has(item._id) && !isCwDismissed(item),
      ),
    [items, displayAdvanced, displayExtra, displayRemoved, dismissVersion],
  );
  // Warm only when a checkpoint actually changes; a new array identity from Home
  // must not restart the identity pass.
  const warmKey = useMemo(
    () => warmItems.map((item) => cwWarmIdentityKey(item)).join("||"),
    [warmItems],
  );
  const warmItemsRef = useRef(warmItems);
  useEffect(() => {
    warmItemsRef.current = warmItems;
  }, [warmItems]);
  useEffect(() => {
    if (!enabled) return;
    cwAnimeWarmStart();
    // Lookup configuration and owner scope are part of the warm trigger: a
    // metadata key that arrives late must be able to resolve identities the
    // earlier attempt could not, even when the card checkpoints are unchanged.
    void warmCwAnimeIdentities(warmItemsRef.current, { tmdbKey })
      .catch(() => {})
      .finally(cwAnimeWarmEnd);
  }, [warmKey, enabled, tmdbKey, privacyOwner, profileId, stremioSourceId]);
  useEffect(() => {
    const active = stateCommitPassRef.current;
    stateCommitPassRef.current = null;
    cwStateCommit(
      {
        advanced: advanced.size,
        extra: extra.length,
        removed: removed.size,
      },
      active?.passId ?? null,
    );
    if (active && activeAdvanceRef.current === active) finishAdvance(active, "complete");
  }, [advanced, extra, removed, displayFailures]);
  const simkl =
    !privacyOwner &&
    simklEnabled &&
    simklSession &&
    remoteProgress?.profileId === profileId &&
    remoteProgress.session === simklSession
      ? remoteProgress.data
      : null;

  // A slow provider must not hold up local completion. Refresh in the background;
  // the shared activity gate/cache coalesces readers across retained pages.
  useEffect(() => {
    if (!enabled || privacyOwner || !simklEnabled || !simklSession) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      void loadSimklProgress()
        .then((data) => {
          if (!cancelled)
            setRemoteProgress((prev) =>
              prev?.profileId === profileId && prev.session === simklSession && prev.data === data
                ? prev
                : { profileId, session: simklSession, data },
            );
        })
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    // Completed sessions disappear from /playback, so an unchanged empty playback
    // list must still discover progress made in another app.
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    enabled,
    privacyOwner,
    profileId,
    simklEnabled,
    simklSession,
    items,
    library,
    watchedVersion,
    simklWatched,
    simklStatus,
    airTick,
  ]);

  useEffect(() => {
    if (!enabled) {
      cancelAdvance();
      setAdvanced((prev) => (prev.size === 0 ? prev : new Map()));
      setExtra((prev) => (prev.length === 0 ? prev : []));
      setRemoved((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const run: AdvanceRun = async (ctx) => {
      const passId = ctx.passId;
      const signal = ctx.signal;
      // Cards not in the row can still hold the same show's real progress
      // (classically an anime-scheme copy hidden from Home).
      cwStaleStart(passId);
      const stalePromise = staleCwIds(
        items,
        progressPool.length > 0 ? progressPool : (library ?? items),
      )
        .catch(() => new Set<string>())
        .then((stale) => {
          cwStaleComplete(passId);
          return stale;
        });
      // Parent maps may still belong to the outgoing account during a profile
      // switch. Only the snapshot tied to this session can drive advancement.
      const effectiveSimklWatched = simkl?.watched ?? EMPTY_SIMKL_WATCHED;
      const effectiveSimklStatus = simkl?.statuses ?? EMPTY_SIMKL_STATUS;
      const remoteCompletionAt = (i: LibraryItem): number | null => {
        const cur = currentEpisode(i);
        if (!cur || i.type !== "series" || !simkl) return null;
        return simkl.watchedAt.get(i._id)?.get(`${cur.season}:${cur.episode}`) ?? null;
      };
      const completedRemotely = (i: LibraryItem): boolean => {
        const cur = currentEpisode(i);
        const at = remoteCompletionAt(i);
        if (!cur || at == null) return false;
        const resume = readResumeEntry(i._id, cur.season, cur.episode);
        const lastPlayed = lastPlayedEpisode(i._id);
        // Imported resume timestamps record fetch time, not playback time. Only
        // locally played progress can overrule the provider's pause/completion dates.
        const mtime: unknown = i._mtime;
        const stamps = [
          Date.parse(i.state?.lastWatched ?? ""),
          typeof mtime === "number" ? mtime : Date.parse(String(mtime)),
        ];
        if (resume && !resume.source) stamps.push(resume.t);
        if (lastPlayed && !lastPlayed.source) stamps.push(lastPlayed.t);
        const activity = Math.max(0, ...stamps.filter(Number.isFinite));
        return (
          at >= activity &&
          watchedPredicate(
            i,
            cur,
            traktWatched,
            effectiveSimklWatched,
            anilistWatched,
            effectiveSimklStatus,
          )(cur.season, cur.episode)
        );
      };
      /**
       * A card that advances is being watched now (or was completed remotely at a
       * known time), so it must carry that activity. Without it the advanced card
       * keeps the finished checkpoint's old timestamp and sinks to the end of the
       * row. Local advancement already has a fresh local playback/resume
       * timestamp; only a remote completion needs to be stamped explicitly so a
       * repeated pass cannot rewrite "now" onto an unchanged card.
       */
      const remoteLastWatched = (i: LibraryItem): { lastWatched?: string } => {
        const at = remoteCompletionAt(i);
        return at != null ? { lastWatched: new Date(at).toISOString() } : {};
      };
      const candidates = items.filter((i) => {
        if (i.external === "nuvio" && i.upNext === true) {
          // A Nuvio Next-Up card is ALREADY pointing to the unwatched episode to watch next.
          // It is not a finished episode session to advance past or drop.
          // If animeCwEnd === "timer", include it so its air date can be evaluated for the countdown timer!
          if ((i as Record<string, unknown>).keptForTimer === true) return true;
          const cur = currentEpisode(i);
          if (cur && manualWatchedState(i._id, cur.season, cur.episode) === true) return true;
          if (animeCwEnd === "timer") return true;
          return false;
        }
        const cur = currentEpisode(i);
        if (!cur) return false;
        return (
          isFinishedSeries(i) ||
          completedRemotely(i) ||
          (i.upNext === true && (i.state?.timeOffset ?? 0) === 0) ||
          (i.state?.flaggedWatched ?? 0) > 0 ||
          manualWatchedState(i._id, cur.season, cur.episode) === true
        );
      });
      const next = new Map<string, LibraryItem>();
      const remove = new Set<string>();
      cwAdvanceCandidates(
        candidates.map((i) => i._id),
        passId,
      );
      // The pass rewrites its own inputs; when nothing else moved, its decisions
      // for unchanged entries are still valid. Repeating them re-fetches lists
      // and re-resolves anime for no new information.
      const passInputs = [
        library,
        watchedVersion,
        traktWatched,
        simklWatched,
        anilistWatched,
        simklStatus,
        progressPool,
        animeVersion,
        episodeHiding,
        hideCaughtUp,
        animeCwEnd,
        animeMode,
        tmdbKey,
        privacyOwner,
        airTick,
        simkl,
        cwEpisodeListCacheToken(),
      ];
      // Expired metadata cannot justify replaying an earlier decision.
      const hasExpiredList = candidates.some(
        (i) =>
          listCacheRef.current.has(i._id) && (listExpiryRef.current.get(i._id) ?? 0) <= Date.now(),
      );
      const priorPass = hasExpiredList ? null : lastPassRef.current;
      const reusable =
        priorPass && priorPass.inputs.every((value, index) => Object.is(value, passInputs[index]))
          ? priorPass.decisions
          : null;
      const decisions = new Map<string, PassDecision>();
      const fetched = new Map<string, ListFetch>();
      // Finished cards whose lookup failed during this pass. They remain
      // readable until a later pass advances, removes or verifies them.
      const failedIds = new Set<string>();
      await prefetchAdvanceLists(candidates, signal, fetched, ctx.isSuperseded);
      if (!ctx.isCurrent()) return;
      // Newer inputs are already queued: release this pass now so the queued one
      // can reuse its started requests instead of working on a stale snapshot.
      if (ctx.isSuperseded()) {
        ctx.supersede();
        return;
      }
      for (const i of candidates) {
        if (ctx.isSuperseded()) {
          ctx.supersede();
          return;
        }
        const prior = reusable?.get(i._id);
        if (prior && sameCwItem(prior.item, i)) {
          if (prior.next) next.set(i._id, prior.next);
          if (prior.remove) remove.add(i._id);
          cwAdvanceOutcome(i._id, "success", passId);
          decisions.set(i._id, prior);
          continue;
        }
        const finishCandidate = () => {
          cwAdvanceOutcome(i._id, "success", passId);
          decisions.set(i._id, {
            item: i,
            next: next.get(i._id),
            remove: remove.has(i._id) || undefined,
          });
        };
        const cur = currentEpisode(i)!;
        const isAnime = isAnimeCwItem(i) || ANIME_ID.test(i._id);
        let list = listCacheRef.current.get(i._id);
        let fetchOk = list !== undefined;
        if (list === undefined) {
          const res = fetched.get(i._id) ?? (await fetchAdvanceList(i));
          if (!ctx.isCurrent()) return;
          if (ctx.isSuperseded()) {
            ctx.supersede();
            return;
          }
          fetchOk = res.ok;
          if (!res.ok) {
            cwAdvanceOutcome(i._id, res.aborted ? "cancelled" : "failure", passId);
            if (res.aborted) return;
            failedIds.add(i._id);
            continue;
          }
          list = res.eps;
        }
        // An empty list is not proof the show has no episodes. Advancing or
        // removing on it would drop a card because a provider was unreachable;
        // leave the card in place and let a later pass retry.
        if (list?.length === 0) {
          cwAdvanceOutcome(i._id, "failure", passId);
          failedIds.add(i._id);
          continue;
        }
        if (!list) {
          failedIds.add(i._id);
          continue;
        }
        // Bulletproof phantom guard: an entry can never show an episode past the last one
        // its own fully-fetched list actually contains. Ordering key = season*1e5+episode so
        // it holds for both season-relative and absolute numbering. Only fires on a clean
        // fetch with a non-empty list, so a transient/partial fetch never clears a good item.
        const orderKey = (s: number, e: number) => s * 100000 + e;
        const seasonMeta = seasonIndex(list);
        const base = clearTimerFlags(i);
        // Timer cards use provider episode dates, which can lag the AniList
        // schedule the detail page shows for currently airing anime. Correct the
        // countdown when AniList's next episode is the card's target.
        const timerSchedule =
          animeCwEnd === "timer" && isAnime
            ? await fetchCwNextAiring(i._id).catch(() => null)
            : null;
        const timerAirDate = (episode: number, fallback?: string) =>
          timerSchedule && episode === timerSchedule.episode
            ? new Date(timerSchedule.airingAt * 1000).toISOString()
            : fallback;
        // Provider dates can be a week late for the current cour. When AniList
        // knows the next airing, its episode boundary is authoritative: earlier
        // episodes have aired, and the named episode has exactly this air date.
        // Only a single-season provider list is safe to rewrite this way.
        if (timerSchedule && new Set(list.map((entry) => entry.season)).size === 1) {
          const airedAt = new Date(Date.now() - 60_000).toISOString();
          for (const entry of list) {
            if (entry.episode === timerSchedule.episode) {
              entry.airDate = new Date(timerSchedule.airingAt * 1000).toISOString();
            } else if (entry.episode < timerSchedule.episode) {
              entry.airDate = airedAt;
            }
          }
        }
        const setCaughtUp = () => {
          next.set(i._id, {
            ...base,
            ...(base.state ? { state: { ...base.state, ...remoteLastWatched(i) } } : {}),
            upNext: undefined,
            waitingForAir: undefined,
            nextAirDate: undefined,
            caughtUp: true,
          } as LibraryItem);
          finishCandidate();
        };
        const dropFinished = () => {
          if (i.external !== "nuvio") remove.add(i._id);
          finishCandidate();
        };
        // An explicit manual-unwatched checkpoint must survive every
        // advancement branch, including season overflow and caught-up handling.
        if (manualWatchedState(i._id, cur.season, cur.episode) === false) {
          next.set(i._id, base);
          finishCandidate();
          continue;
        }
        const origCur = cur;
        let effCur = cur;
        let remappedMixed = false;
        // True when the fetched list cannot place the finished episode at all
        // (it may not even know the sequel season). The primary next-episode
        // scan is meaningless then, and the row needs the anime-entry fallback
        // before any drop decision.
        let unplacedCur = false;
        let nextEp: PlayEpisode | null = null;
        const scoped = scopedSplitItem(i._id);
        if (fetchOk && list.length > 0) {
          const maxKey = seasonMeta.maxOrderKey;
          if (
            orderKey(effCur.season, effCur.episode) > maxKey &&
            seasonMeta.maxEpisode.has(effCur.season)
          ) {
            const abs = list.find((e) => e.absoluteNumber === effCur.episode);
            if (!abs) {
              unplacedCur = true;
            } else {
              effCur = { season: abs.season, episode: abs.episode };
            }
          }
          if (!list.some((e) => e.season === effCur.season && e.episode === effCur.episode)) {
            const maxSeasonEp = seasonMeta.maxEpisode.get(effCur.season);
            if (maxSeasonEp !== undefined && effCur.episode > maxSeasonEp) {
              // Season was completed; advance to first episode of next season
              const nextSeasonEps = list
                .filter((e) => e.season > effCur.season)
                .filter((e) => !isUnannouncedSeason(e, isAnime, effCur.season))
                .sort((a, b) => a.season - b.season || a.episode - b.episode);
              const unannouncedNext =
                nextSeasonEps.length === 0 &&
                list.some((e) => isUnannouncedSeason(e, isAnime, effCur.season));
              if (unannouncedNext) {
                if (i.external !== "nuvio") remove.add(i._id);
                finishCandidate();
                continue;
              }
              if (nextSeasonEps.length > 0) {
                const checkWatched = watchedPredicate(
                  i,
                  effCur,
                  traktWatched,
                  effectiveSimklWatched,
                  anilistWatched,
                  effectiveSimklStatus,
                  !!privacyOwner,
                );
                const nextUnwatched = nextSeasonEps.find((e) => !checkWatched(e.season, e.episode));
                if (nextUnwatched) {
                  if (nextEpAired(list, nextUnwatched, isAnime, effCur.season)) {
                    next.set(i._id, {
                      ...base,
                      state: {
                        ...i.state!,
                        season: nextUnwatched.season,
                        episode: nextUnwatched.episode,
                        video_id: `${i._id}:${nextUnwatched.season}:${nextUnwatched.episode}`,
                        timeOffset: 0,
                        flaggedWatched: 0,
                        ...remoteLastWatched(i),
                      },
                      upNext: true,
                    });
                  } else if (animeCwEnd === "timer" && nextUnwatched.airDate) {
                    next.set(i._id, {
                      ...base,
                      state: {
                        ...i.state!,
                        season: nextUnwatched.season,
                        episode: nextUnwatched.episode,
                        video_id: `${i._id}:${nextUnwatched.season}:${nextUnwatched.episode}`,
                        timeOffset: 0,
                        flaggedWatched: 0,
                        ...remoteLastWatched(i),
                      },
                      upNext: true,
                      waitingForAir: true as const,
                      nextAirDate: timerAirDate(nextUnwatched.episode, nextUnwatched.airDate),
                    } as LibraryItem);
                  } else if (animeCwEnd === "timer" && !hideCaughtUp) {
                    setCaughtUp();
                  } else {
                    dropFinished();
                  }
                  finishCandidate();
                  continue;
                } else {
                  // Every episode that has aired is watched.
                  if (animeCwEnd === "timer" && !hideCaughtUp) setCaughtUp();
                  else dropFinished();
                  continue;
                }
              } else {
                // No next season in provider list: check if an anime sequel cour exists
                let followUp: PlayEpisode | null = null;
                const tryAnimeEntry =
                  isAnime || i._id.startsWith("tt") || i._id.startsWith("tmdb:");
                if (tryAnimeEntry && !privacyOwner) {
                  const checkWatched = watchedPredicate(
                    i,
                    effCur,
                    traktWatched,
                    effectiveSimklWatched,
                    anilistWatched,
                    effectiveSimklStatus,
                    !!privacyOwner,
                  );
                  try {
                    followUp = await animeEntryFollowUp(
                      i,
                      effCur,
                      tmdbKey,
                      checkWatched,
                      undefined,
                      listCacheRef.current,
                      signal,
                      ctx.isCurrent,
                      animeFailureRef.current,
                    );
                  } catch {
                    // The sequel list could not be read. That is not proof the
                    // series is over, so keep the card and let a later pass retry.
                    if (!ctx.isCurrent()) return;
                    cwAdvanceOutcome(i._id, "failure", passId);
                    continue;
                  }
                  if (!ctx.isCurrent()) return;
                }
                if (followUp) {
                  nextEp = followUp;
                  unplacedCur = false;
                } else if (animeCwEnd === "timer" && !hideCaughtUp) {
                  setCaughtUp();
                  continue;
                } else {
                  // Entire series is completed and no next target is verified.
                  dropFinished();
                  continue;
                }
              }
            } else if (!unplacedCur && scoped) {
              const hintSeason = preferredMixedSeason(
                privacyOwner ? undefined : getViewedSeason(i._id),
                lastPlayedEpisode(i._id)?.season,
              );
              const resolved = resolveEffectiveEpisode(
                list,
                effCur.season,
                effCur.episode,
                hintSeason,
              );
              effCur = { season: resolved.season, episode: resolved.episode };
              remappedMixed = resolved.remappedMixed;
            } else {
              const mapped = list.find(
                (e) => e.imdbSeason === effCur.season && e.imdbEpisode === effCur.episode,
              );
              if (mapped) effCur = { season: mapped.season, episode: mapped.episode };
            }
            if (!list.some((e) => e.season === effCur.season && e.episode === effCur.episode)) {
              unplacedCur = true;
            }
          }
        }
        const curEpInList = list.find(
          (e) => e.season === effCur.season && e.episode === effCur.episode,
        );
        if (curEpInList && !nextEpAired(list, curEpInList, isAnime, effCur.season)) {
          if (animeCwEnd === "timer" && curEpInList.airDate) {
            next.set(i._id, {
              ...base,
              waitingForAir: true as const,
              nextAirDate: timerAirDate(curEpInList.episode, curEpInList.airDate),
            } as LibraryItem);
            finishCandidate();
            continue;
          } else if (animeCwEnd === "timer" && !hideCaughtUp) {
            setCaughtUp();
            continue;
          } else if (i.external !== "nuvio") {
            dropFinished();
            continue;
          }
        }

        if (i.external === "nuvio" && i.upNext === true) {
          if (
            animeCwEnd === "timer" &&
            (!curEpInList || !nextEpAired(list, curEpInList, isAnime, effCur.season)) &&
            curEpInList?.airDate
          ) {
            next.set(i._id, {
              ...base,
              waitingForAir: true as const,
              nextAirDate: timerAirDate(curEpInList.episode, curEpInList.airDate),
            } as LibraryItem);
          } else if (
            animeCwEnd === "timer" &&
            (!curEpInList || !nextEpAired(list, curEpInList, isAnime, effCur.season)) &&
            !hideCaughtUp
          ) {
            setCaughtUp();
            continue;
          } else if (
            curEpInList &&
            nextEpAired(list, curEpInList, isAnime, effCur.season) &&
            (i as Record<string, unknown>).waitingForAir === true
          ) {
            next.set(i._id, base);
          }
          const isKeptWatched =
            (i as Record<string, unknown>).keptForTimer === true ||
            (i as Record<string, unknown>).waitingForAir === true;
          const isSeasonOverflow =
            !curEpInList &&
            seasonMeta.maxEpisode.has(effCur.season) &&
            effCur.episode > (seasonMeta.maxEpisode.get(effCur.season) ?? 0);
          if (!isKeptWatched && !isSeasonOverflow) {
            const checkWatched = watchedPredicate(
              i,
              effCur,
              traktWatched,
              effectiveSimklWatched,
              anilistWatched,
              effectiveSimklStatus,
              !!privacyOwner,
            );
            if (!checkWatched(effCur.season, effCur.episode)) {
              finishCandidate();
              continue;
            }
          }
        }

        const checkWatched = watchedPredicate(
          i,
          effCur,
          traktWatched,
          effectiveSimklWatched,
          anilistWatched,
          effectiveSimklStatus,
          !!privacyOwner,
        );
        const aliasCur = scoped ? providerAliasCoords(list, effCur.season, effCur.episode) : [];
        const manualUnwatched = manualWatchedState(i._id, effCur.season, effCur.episode) === false;
        const waiting = (i as Record<string, unknown>).waitingForAir === true;
        const watchedCur =
          checkWatched(effCur.season, effCur.episode) ||
          aliasCur.some((a) => checkWatched(a.season, a.episode)) ||
          (!manualUnwatched &&
            (waiting ||
              (i.external === "nuvio" && (i as Record<string, unknown>).keptForTimer === true)));
        if (!watchedCur) {
          if (waiting) next.set(i._id, base);
          finishCandidate();
          continue;
        }
        const nextSkip = episodeHiding
          ? (s: number, e: number) => isEpisodeHidden(i._id, s, e)
          : undefined;
        const curIdx = list.findIndex(
          (e) => e.season === effCur.season && e.episode === effCur.episode,
        );
        let immediateNext: PlayEpisode | null = null;
        if (curIdx >= 0) {
          for (let k = curIdx + 1; k < list.length; k++) {
            if (nextSkip?.(list[k].season, list[k].episode)) continue;
            immediateNext = list[k];
            break;
          }
        }
        if (!nextEp) {
          nextEp = unplacedCur
            ? null
            : nextUnwatchedAfter(
                list,
                effCur,
                (s: number, e: number): boolean => {
                  if (s === effCur.season && e === effCur.episode) return true;
                  if (privacyOwner) return false;
                  if (checkWatched(s, e)) return true;
                  if (!scoped) return false;
                  return providerAliasCoords(list, s, e).some((a) =>
                    checkWatched(a.season, a.episode),
                  );
                },
                nextSkip,
              );
        }
        if (immediateNext && nextEp && nextEp.season > immediateNext.season) {
          nextEp = immediateNext;
        }
        // A sequel season can be missing from the provider list entirely, even
        // for a catalog row the app never flagged as anime (an IMDb/TMDB row not
        // covered by detection). When the provider list cannot place the
        // finished episode, try the anime entry resolver; it returns null for an
        // ordinary series, so the attempt stays bounded to unplaceable rows.
        const tryAnimeEntry =
          isAnime || (unplacedCur && (i._id.startsWith("tt") || i._id.startsWith("tmdb:")));
        // A follow-up resolved from the recorded anime entry while the finished
        // episode is unplaceable in provider space. When that follow-up has not
        // aired yet its provider numbering cannot be trusted, so the card keeps the
        // finished episode and only shows the countdown for the recorded air date.
        let unplacedFollowUp: PlayEpisode | null = null;
        if ((!nextEp || unplacedCur) && tryAnimeEntry && !privacyOwner) {
          try {
            const followUp = await animeEntryFollowUp(
              i,
              effCur,
              tmdbKey,
              checkWatched,
              nextSkip,
              listCacheRef.current,
              signal,
              ctx.isCurrent,
              animeFailureRef.current,
            );
            if (!ctx.isCurrent()) return;
            if (followUp) {
              nextEp = followUp;
              if (unplacedCur) unplacedFollowUp = followUp;
            }
          } catch {
            if (!ctx.isCurrent()) return;
            // An unavailable sequel list is not a finished series. Keep the card.
            cwAdvanceOutcome(i._id, "failure", passId);
            failedIds.add(i._id);
            continue;
          }
        }
        // A future season with no air date is a placeholder, not the next
        // episode. Drop it even in timer mode instead of keeping a phantom card.
        if (
          nextEp &&
          isUnannouncedSeason(nextEp, isAnime, effCur.season) &&
          i.external !== "nuvio"
        ) {
          remove.add(i._id);
          finishCandidate();
          continue;
        }
        if (
          unplacedFollowUp &&
          unplacedFollowUp.airDate &&
          !nextEpAired(list, unplacedFollowUp, isAnime, effCur.season)
        ) {
          next.set(i._id, {
            ...base,
            ...(base.state ? { state: { ...base.state, ...remoteLastWatched(i) } } : {}),
            waitingForAir: true as const,
            nextAirDate: timerAirDate(unplacedFollowUp.episode, unplacedFollowUp.airDate),
          } as LibraryItem);
          finishCandidate();
          continue;
        }
        if (nextEp && nextEpAired(list, nextEp, isAnime, effCur.season)) {
          const display = cwNextDisplayCoords(
            origCur,
            effCur,
            nextEp,
            remappedMixed,
            i.state?.season === 0,
          );
          next.set(i._id, {
            ...base,
            // Provider numbering is a display-only proof, separate from the
            // raw episode and stream IDs used for playback and dismissals.
            cwVerifiedProviderMapping:
              Number.isInteger(nextEp.imdbSeason) &&
              (nextEp.imdbSeason ?? 0) >= 1 &&
              Number.isInteger(nextEp.imdbEpisode) &&
              (nextEp.imdbEpisode ?? 0) >= 1
                ? { imdbSeason: nextEp.imdbSeason!, imdbEpisode: nextEp.imdbEpisode! }
                : undefined,
            state: {
              ...i.state!,
              season: display.season,
              episode: display.episode,
              video_id: nextEp.kitsuStreamId ?? `${i._id}:${display.season}:${display.episode}`,
              timeOffset: 0,
              flaggedWatched: 0,
              ...remoteLastWatched(i),
            },
            upNext: true,
          });
        } else if (
          animeCwEnd === "timer" &&
          nextEp &&
          nextEp.airDate &&
          !isUnannouncedSeason(nextEp, isAnime, effCur.season)
        ) {
          const displaySeason = remappedMixed
            ? nextEp.season
            : origCur.season !== effCur.season
              ? origCur.season
              : nextEp.season;
          next.set(i._id, {
            ...base,
            state: {
              ...i.state!,
              season: displaySeason,
              episode: nextEp.episode,
              video_id: `${i._id}:${displaySeason}:${nextEp.episode}`,
              timeOffset: 0,
              flaggedWatched: 0,
              ...remoteLastWatched(i),
            },
            upNext: true,
            waitingForAir: true as const,
            nextAirDate: timerAirDate(nextEp.episode, nextEp.airDate),
          } as LibraryItem);
        } else if (
          animeCwEnd === "timer" &&
          !hideCaughtUp &&
          (!nextEp || !nextEp.airDate || unplacedCur)
        ) {
          // A known next episode without an air date is not a countdown, and
          // an unplaceable row has no verified target. Keep a neutral card
          // only when the user asked to keep caught-up shows.
          setCaughtUp();
          continue;
        } else if (
          i.external !== "nuvio" &&
          (shouldDropFinished(
            list,
            fetchOk,
            completedRemotely(i) ? undefined : i.state,
            animeMode,
            effCur,
            nextEp,
            hideCaughtUp,
          ) ||
            (animeCwEnd === "hide" &&
              (!nextEp || !nextEpAired(list, nextEp, isAnime, effCur.season))))
        ) {
          remove.add(i._id);
        }
        finishCandidate();
      }
      lastPassRef.current = { inputs: passInputs, decisions };
      const baseLibrary = privacyOwner
        ? listLocalCw(true)
            .filter((entry) => localCwSourceEnabled(entry, settings.cwSources))
            .map(localToLibraryItem)
        : (library ?? items);
      // Playback endpoints remove finished sessions. Keep recent completion anchors
      // available to the existing aired-episode resurfacing path, without saving fake progress.
      const libById = new Map(baseLibrary.map((i) => [i._id, i]));
      const remoteSeries = (simkl?.completedSeries ?? [])
        .filter((i) => {
          const status = simkl?.statuses.get(i._id);
          return (status === "watching" || status === "completed") && completedRemotely(i);
        })
        .sort((a, b) => Date.parse(b._mtime) - Date.parse(a._mtime))
        .slice(0, 40);
      for (const remote of remoteSeries) {
        const times = simkl!.watchedAt.get(remote._id);
        const existing = baseLibrary.find(
          (i) => i._id === remote._id || (times && simkl!.watchedAt.get(i._id) === times),
        );
        if (existing) {
          // A removed title, a newer local watch, or an active pause owns its slot.
          // Only replace an older inactive anchor, preserving its identity and art.
          if (
            (existing.removed && !existing.temp) ||
            isCwMember(existing) ||
            Date.parse(existing.state?.lastWatched ?? existing._mtime) > Date.parse(remote._mtime)
          )
            continue;
          const cur = currentEpisode(remote)!;
          if (manualWatchedState(existing._id, cur.season, cur.episode) === false) continue;
          libById.set(existing._id, {
            ...existing,
            state: { ...remote.state!, video_id: `${existing._id}:${cur.season}:${cur.episode}` },
          });
        } else {
          libById.set(remote._id, remote);
        }
      }
      const lib = [...libById.values()];
      const inCw = new Set(items.map((i) => i._id));
      const watchedFor = (item: LibraryItem, c: { season: number; episode: number }) =>
        watchedPredicate(
          item,
          c,
          traktWatched,
          effectiveSimklWatched,
          anilistWatched,
          effectiveSimklStatus,
          !!privacyOwner,
        );
      cwResurfaceStart(passId);
      const resurfacePromise = resurfaceCandidates(
        lib,
        inCw,
        { tmdbKey, animeMode, animeCwEnd, hideCaughtUp },
        watchedFor,
      )
        .catch(() => new Map<string, ResurfaceTarget>())
        .then((resurfaced) => {
          cwResurfaceComplete(passId);
          return resurfaced;
        });
      const [resurfaced, stale] = await Promise.all([resurfacePromise, stalePromise]);
      for (const id of stale) remove.add(id);
      if (!ctx.isCurrent()) return;
      const extraItems: LibraryItem[] = [];
      for (const [id, ep] of resurfaced) {
        if (next.has(id)) continue;
        const src = lib.find((i) => i._id === id);
        if (!src?.state) continue;
        const schedule =
          animeCwEnd === "timer" && (isAnimeCwItem(src) || ANIME_ID.test(id))
            ? await fetchCwNextAiring(id).catch(() => null)
            : null;
        const airDate =
          schedule && ep.episode === schedule.episode
            ? new Date(schedule.airingAt * 1000).toISOString()
            : ep.airDate;
        extraItems.push({
          ...src,
          state: {
            ...src.state,
            season: ep.season,
            episode: ep.episode,
            video_id: `${id}:${ep.season}:${ep.episode}`,
            timeOffset: 0,
            flaggedWatched: 0,
          },
          upNext: ep.caughtUp ? undefined : true,
          caughtUp: ep.caughtUp,
          waitingForAir: ep.waitingForAir,
          nextAirDate: airDate,
        });
      }
      if (ctx.isCurrent() && !ctx.isSuperseded() && animeCwEnd === "timer") {
        let soonest = Infinity;
        for (const it of [...next.values(), ...extraItems]) {
          const air = (it as Record<string, unknown>).nextAirDate;
          if (typeof air !== "string") continue;
          const at = Date.parse(air);
          if (Number.isFinite(at) && at > Date.now() && at < soonest) soonest = at;
        }
        if (airTimerRef.current !== null) window.clearTimeout(airTimerRef.current);
        airTimerRef.current = null;
        if (soonest !== Infinity) {
          const delay = Math.max(1000, Math.min(soonest - Date.now() + 1000, 21600000));
          airTimerRef.current = window.setTimeout(() => setAirTick((n) => n + 1), delay);
        }
      }
      if (ctx.isCurrent()) {
        // Newer inputs are already queued. Finish this pass and release the
        // slot, but never publish results computed from the older snapshot.
        if (ctx.isSuperseded()) {
          ctx.supersede();
          return;
        }
        const nextOwner = {
          privacyOwner,
          profileId,
          stremioSourceId,
          stremioAuthKey,
          traktIdentity,
          nuvioSlot,
          nuvioAccountId,
          accountProvider: settings.accountProvider,
          tmdbKey,
          sources: sourceKey,
          simklSession,
          simklEnabled,
        };
        // A new owner object is a React state change on every pass, even when
        // nothing about the owner moved.
        const ownerChanged =
          resolvedOwner.privacyOwner !== nextOwner.privacyOwner ||
          resolvedOwner.profileId !== nextOwner.profileId ||
          resolvedOwner.stremioSourceId !== nextOwner.stremioSourceId ||
          resolvedOwner.stremioAuthKey !== nextOwner.stremioAuthKey ||
          resolvedOwner.traktIdentity !== nextOwner.traktIdentity ||
          resolvedOwner.nuvioSlot !== nextOwner.nuvioSlot ||
          resolvedOwner.nuvioAccountId !== nextOwner.nuvioAccountId ||
          resolvedOwner.accountProvider !== nextOwner.accountProvider ||
          resolvedOwner.tmdbKey !== nextOwner.tmdbKey ||
          resolvedOwner.sources !== nextOwner.sources ||
          resolvedOwner.simklSession !== nextOwner.simklSession ||
          resolvedOwner.simklEnabled !== nextOwner.simklEnabled;
        if (ownerChanged) setResolvedOwner(nextOwner);
        // A metadata error cannot invalidate a previously verified checkpoint.
        // Fully processed inputs, including legitimate no-next results, retire
        // their provisional display, but unrelated partial hydration does not.
        const unresolvedIds = new Set(
          candidates.filter((item) => !decisions.has(item._id)).map((item) => item._id),
        );
        saveCwDisplaySnapshot(displayScope, items, next, remove, {
          library: lib,
          extra: extraItems,
          unresolvedIds,
        });
        if (restoredDisplay.advanced.size > 0 || verifiedInputs.fingerprints.size > 0) {
          const fingerprints = new Map(
            items
              .filter((item) => !unresolvedIds.has(item._id))
              .map((item) => [item._id, cwDisplayInputFingerprint(item)] as const),
          );
          setVerifiedInputs((previous) => {
            if (
              previous.scope === displayScope &&
              previous.fingerprints.size === fingerprints.size &&
              [...fingerprints].every(
                ([id, fingerprint]) => previous.fingerprints.get(id) === fingerprint,
              )
            )
              return previous;
            return { scope: displayScope, fingerprints };
          });
        }
        // An empty startup pass is not evidence that the provider/library
        // snapshot is ready. Keep the validated display available when data
        // arrives later during hydration.
        if (items.length > 0 || lib.length > 0) setLiveDisplayScope(displayScope);
        const advancedChanged = !sameMap(advancedRef.current, next);
        const extraChanged = !sameList(extraRef.current, extraItems);
        const removedChanged = !sameSet(removedRef.current, remove);
        // An empty pass must not introduce a display commit. Only publish when
        // there is a failure to show or a previous failure to clear.
        const failuresChanged =
          failedIds.size > 0 || displayFailuresRef.current.size > 0
            ? !sameSet(displayFailuresRef.current, failedIds)
            : false;
        if (failuresChanged) {
          displayFailuresRef.current = failedIds;
          setDisplayFailures(failedIds);
        }
        // Skip the dispatch itself when the result is equivalent: returning
        // `prev` prevents a write but still schedules the update.
        if (advancedChanged) setAdvanced(next);
        if (extraChanged) setExtra(extraItems);
        if (removedChanged) setRemoved(remove);
        if (advancedChanged || extraChanged || removedChanged || failuresChanged) {
          ctx.markCommit();
        } else {
          // Nothing to publish: complete without a state commit. Completion
          // must never depend on a React write that will not happen.
          ctx.complete();
        }
      }
    };
    requestAdvance(run, owner);
  }, [
    items,
    tmdbKey,
    enabled,
    library,
    animeMode,
    watchedVersion,
    traktWatched,
    simklWatched,
    anilistWatched,
    simklStatus,
    animeVersion,
    episodeHiding,
    hideCaughtUp,
    animeCwEnd,
    progressPool,
    airTick,
    privacyOwner,
    profileId,
    stremioSourceId,
    stremioAuthKey,
    traktIdentity,
    nuvioSlot,
    nuvioAccountId,
    simklSession,
    simklEnabled,
    simkl,
    settings.cwSources,
    settings.accountProvider,
  ]);

  useEffect(() => {
    return () => cancelAdvance();
  }, []);

  if (
    !enabled ||
    resolvedOwner.privacyOwner !== privacyOwner ||
    resolvedOwner.profileId !== profileId ||
    resolvedOwner.stremioSourceId !== stremioSourceId ||
    resolvedOwner.stremioAuthKey !== stremioAuthKey ||
    resolvedOwner.traktIdentity !== traktIdentity ||
    resolvedOwner.nuvioSlot !== nuvioSlot ||
    resolvedOwner.nuvioAccountId !== nuvioAccountId ||
    resolvedOwner.accountProvider !== settings.accountProvider ||
    resolvedOwner.tmdbKey !== tmdbKey ||
    resolvedOwner.sources !== sourceKey ||
    resolvedOwner.simklSession !== simklSession ||
    resolvedOwner.simklEnabled !== simklEnabled
  )
    return sortCwFinal(
      dedupeCwItems(
        // Do not reuse the previous account's in-memory advancement during owner
        // hydration. An exact checkpoint proof restored under the *new* owner
        // scope is safe to display until its live pass finishes.
        items
          .map((i) => (i.removed && i.temp ? i : (restoredDisplay.advanced.get(i._id) ?? i)))
          .filter(
            (i) =>
              isPlayableCwDisplay(i, enabled) &&
              !isCwDismissed(i) &&
              (animeMode !== "exclude" || !isAnimeCwItem(i)),
          ),
        Infinity,
      ),
    );
  // Dismissal targets the displayed up-next episode, which may differ from the
  // library entry. Filter stored display results immediately, without refetching.
  const base = items
    .map((i) => displayAdvanced.get(i._id) ?? i)
    // Completed source checkpoints still reach the advancement worker through
    // `items`, but cannot flash as resumable cards before next-up verification.
    .filter(
      (i) =>
        isPlayableCwDisplay(i, enabled, unresolvedDisplayIds) &&
        !displayRemoved.has(i._id) &&
        !isCwDismissed(i) &&
        (animeMode !== "exclude" || !isAnimeCwItem(i)),
    );
  if (displayExtra.length === 0) return sortCwFinal(dedupeCwItems(dedupeAnimeCw(base), Infinity));
  const keyOf = (i: LibraryItem) => `${i.type}|${franchiseDedupKey(i.name ?? "")}`;
  const animeIdentity = (i: LibraryItem) =>
    isAnimeCwItem(i) || cwAnimeIdentityKey(i._id, i.state?.video_id, i.state) != null;
  const baseKeys = new Set(base.filter((i) => !animeIdentity(i)).map(keyOf));
  const dedupExtra = displayExtra.filter(
    (i) =>
      (animeIdentity(i) || !baseKeys.has(keyOf(i))) &&
      !isCwDismissed(i) &&
      (animeMode !== "exclude" || !isAnimeCwItem(i)),
  );
  return sortCwFinal(
    dedupeCwItems(
      dedupeAnimeCw(dedupExtra.length === 0 ? base : base.concat(dedupExtra)),
      Infinity,
    ),
  );
}
