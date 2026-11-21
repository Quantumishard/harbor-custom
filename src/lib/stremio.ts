import { safeFetch as fetch } from "@/lib/safe-fetch";
import { readResumeEntry, readResumeSource } from "@/lib/resume";
import { isDetectedAnime } from "./anime-detect";
import { isNuvioProviderActive } from "@/lib/active-profile-id";
import { collectAllNuvioItemIds } from "@/lib/nuvio/nuvio-client";
import { sanitizeStremioLocalCw } from "@/lib/local-cw";
import { manualWatchedState } from "@/lib/manual-watched";

const API = "https://api.strem.io/api";

export const CW_FINISHED_RATIO = 0.9;

export type User = {
  _id: string;
  email: string;
  fullname?: string;
  avatar?: string;
};

export type ExternalCwSource = "simkl" | "trakt" | "nuvio" | "publicmetadb";

export type LibraryItem = {
  _id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  state?: {
    timeOffset: number;
    duration: number;
    season?: number;
    episode?: number;
    timeWatched?: number;
    flaggedWatched?: number;
    timesWatched?: number;
    watched?: string;
    video_id?: string;
    lastWatched?: string;
  };
  removed: boolean;
  temp: boolean;
  _ctime: string;
  _mtime: string;
  external?: ExternalCwSource;
  /** Other canonical ids for the same title, used to merge and dismiss CW entries. */
  altIds?: string[];
  /** Saved playback/resume ids by external provider, used when clearing provider progress. */
  providerPlaybackIds?: Partial<Record<"trakt" | "simkl" | "publicmetadb", string>>;
  /** Original source checkpoints represented by a verified anime CW group. */
  cwMembers?: LibraryItem[];
  /** Display-only native correction: resume/sync still use the original source id. */
  cwRepairSourceId?: string;
  /** Verified exact native stream for offline picker/tracker resolution. */
  cwRepairNativeStreamId?: string;
  isAnime?: boolean;
  upNext?: boolean;
  /** A verified caught-up card: show it neutrally without a countdown. */
  caughtUp?: boolean;
  /** Provisional, verified provider episode coordinates for CW card presentation only.
   * Never use this for playback progress, ownership, or provider dismissal. */
  cwVerifiedProviderMapping?: { imdbSeason: number; imdbEpisode: number };
  waitingForAir?: boolean;
  nextAirDate?: string;
  local?: boolean;
  manualWatched?: boolean;
};

export function libraryMetaType(t: string): import("@/lib/cinemeta").MetaType {
  return t === "series" || t === "channel" || t === "tv" || t === "anime" || t === "other"
    ? t
    : "movie";
}

export function isAnimeCwItem(i: LibraryItem): boolean {
  return /^(kitsu|mal|anilist|anidb):/.test(i._id) || i.isAnime === true || isDetectedAnime(i._id);
}

export function episodeFromVideoId(
  videoId: string | undefined | null,
): { season: number; episode: number } | null {
  if (!videoId) return null;
  const parts = videoId.split(":");
  if (parts.length < 3) return null;
  const season = Number(parts[parts.length - 2]);
  const episode = Number(parts[parts.length - 1]);
  if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
    return null;
  }
  return { season, episode };
}

/**
 * The episode a Continue Watching card actually represents. Complete state
 * coordinates win, including season zero for Specials. An exact local source
 * checkpoint can prove a merged library's 0:0 is only a watched-sync placeholder.
 * Native anime stream ids are entry-relative, never a season; nothing is
 * invented when coordinates are incomplete or malformed.
 */
export function resolvedEpisodeCoords(
  item: Pick<LibraryItem, "_id" | "state"> &
    Partial<Pick<LibraryItem, "removed" | "temp" | "cwMembers">>,
): { season: number; episode: number } | null {
  const season = item.state?.season;
  const episode = item.state?.episode;
  const videoId = item.state?.video_id ?? "";
  if (
    typeof season === "number" &&
    typeof episode === "number" &&
    Number.isInteger(season) &&
    Number.isInteger(episode) &&
    season >= 0 &&
    episode >= 0
  ) {
    // Watched sync can leave a removed temp record at 0:0 while its own saved
    // playback video still identifies an episode. This is not a Season 0
    // special: only replace the double-zero placeholder when the video id
    // belongs to this exact record and names a real episode.
    if (season === 0 && episode === 0) {
      const encoded = episodeFromVideoId(videoId);
      if (
        encoded &&
        encoded.episode > 0 &&
        videoId === `${item._id}:${encoded.season}:${encoded.episode}`
      ) {
        if (item.removed === true && item.temp === true) return encoded;
        // An ordinary library row can keep 0:0 after Stremio marks an episode
        // watched, even though the same merged CW card retains its actual local
        // S3E1 checkpoint. Trust this only with independent local evidence;
        // the video id alone must never turn a genuine S0 special into S3.
        if (
          encoded.season >= 1 &&
          item.cwMembers?.some((member) =>
            member.local === true &&
            member._id === item._id &&
            member.state?.video_id === videoId &&
            member.state.season === encoded.season &&
            member.state.episode === encoded.episode &&
            (member.state.timeOffset ?? 0) > 0
          )
        ) return encoded;
      }
    }
    return { season, episode };
  }
  const native = /^(?:kitsu|mal|anilist|anidb):\d+:(\d+)$/.exec(videoId);
  if (native) {
    const number = Number(native[1]);
    return number > 0 ? { season: 1, episode: number } : null;
  }
  return episodeFromVideoId(videoId);
}

function resumeForItem(i: LibraryItem): { ms: number; t: number } | null {
  const coords = resolvedEpisodeCoords(i);
  return readResumeEntry(i._id, coords?.season, coords?.episode);
}

export function resumeSourceForItem(i: LibraryItem): ExternalCwSource | undefined {
  const coords = resolvedEpisodeCoords(i);
  return readResumeSource(i._id, coords?.season, coords?.episode);
}

// True only when CW eligibility comes from the harbor.resume fallback (no cloud
// progress of its own), so a disabled source's backfill cannot resurrect library cards.
export function cwMemberViaResume(i: LibraryItem): boolean {
  if (i.removed && !i.temp) return false;
  if (!i.state) return (resumeForItem(i)?.ms ?? 0) > 0;
  const duration = i.state.duration ?? 0;
  const finishedByRatio = duration > 0 && i.state.timeOffset / duration >= CW_FINISHED_RATIO;
  if (i.type === "movie" && ((i.state.flaggedWatched ?? 0) > 0 || finishedByRatio)) return false;
  if (i.state.timeOffset > 0) return false;
  if ((i.state.flaggedWatched ?? 0) > 0) return false;
  const local = resumeForItem(i)?.ms ?? 0;
  if (local <= 0) return false;
  if (duration > 0 && local / duration >= CW_FINISHED_RATIO) return false;
  return true;
}

export function cwSortKey(i: LibraryItem): number {
  const lastWatched = Date.parse(i.state?.lastWatched ?? "");
  const m = i._mtime as unknown;
  const mtime = typeof m === "number" ? m : Date.parse(String(m ?? ""));
  // Recency must agree with the dismiss check's itemActivity: Harbor and external
  // playback imports record freshness in `harbor.resume` without touching the cloud
  // _mtime/lastWatched. Otherwise an item un-dismissed by fresh resume keeps sorting
  // by its stale cloud timestamp and sinks to the end of Continue Watching.
  let best = resumeForItem(i)?.t ?? 0;
  if (Number.isFinite(lastWatched)) best = Math.max(best, lastWatched);
  if (Number.isFinite(mtime)) best = Math.max(best, mtime);
  return best;
}

/**
 * A completed removed/temp series is still a source for episode advancement
 * and resurfacing, but its already-watched checkpoint must not flash as an
 * active CW card while the next episode is unresolved.
 */
export function isCwDisplayReady(i: LibraryItem): boolean {
  if (i.type !== "series" || !i.removed || !i.temp || i.upNext || i.waitingForAir || i.caughtUp) {
    return true;
  }
  const state = i.state;
  if (!state) return true;
  const duration = state.duration ?? 0;
  const completedByRatio = duration > 0 && (state.timeOffset ?? 0) / duration >= CW_FINISHED_RATIO;
  return (state.flaggedWatched ?? 0) <= 0 && !completedByRatio;
}

export function isCwMember(i: LibraryItem): boolean {
  if (i.removed && !i.temp) return false;
  if (i.upNext) return true;
  if (i.waitingForAir) return true;
  if (i.caughtUp) return true;
  // A removed item survives only as a temp progress record. Without playback
  // progress or a resume entry there is nothing to continue, and the placeholder
  // `season: 0 / episode: 0` state written by watched sync must not become a card.
  if (i.removed && (i.state?.timeOffset ?? 0) <= 0 && (resumeForItem(i)?.ms ?? 0) <= 0) {
    return false;
  }
  // External trackers (Simkl, Trakt, PublicMetaDB) without upNext must be active in-progress
  // playback sessions (1% <= progress <= 98%, timeOffset > 0, unflagged).
  if (i.external === "simkl" || i.external === "trakt" || i.external === "publicmetadb") {
    if (!i.state) return false;
    const offset = i.state.timeOffset ?? 0;
    const duration = i.state.duration ?? 0;
    if (offset <= 0 || (i.state.flaggedWatched ?? 0) > 0) return false;
    if (duration > 0 && offset / duration >= CW_FINISHED_RATIO) return false;
    return true;
  }
  if (!i.state) {
    const local = resumeForItem(i)?.ms ?? 0;
    return local > 0;
  }
  const duration = i.state.duration ?? 0;
  const finishedByRatio = duration > 0 && i.state.timeOffset / duration >= CW_FINISHED_RATIO;
  if (i.type === "movie" && ((i.state.flaggedWatched ?? 0) > 0 || finishedByRatio)) return false;
  if (i.state.timeOffset > 0) return true;
  if (i.state && i.state.season == null && i.state.video_id) {
    const se = episodeFromVideoId(i.state.video_id);
    if (se) {
      i.state.season = se.season;
      i.state.episode = se.episode;
    }
  }
  const season = i.state.season;
  const episode = i.state.episode;
  if (
    i.type === "series" &&
    season != null &&
    season > 0 &&
    episode != null &&
    episode > 0 &&
    (i.state.flaggedWatched ?? 0) === 0
  ) {
    return true;
  }
  if ((i.state.flaggedWatched ?? 0) > 0) {
    // A watched episode normally retires the card, but a series the viewer just
    // marked has to stay in the tray so the advancer can roll over to the next
    // episode or draw the "airing soon" timer card. The advancer removes the row
    // itself once the series is caught up and the end mode hides it, so keeping
    // the row here never leaks a finished show back into Continue Watching.
    if (
      i.type === "series" &&
      season != null &&
      season > 0 &&
      episode != null &&
      episode > 0 &&
      (i.manualWatched === true ||
        i.external === "nuvio" ||
        (typeof manualWatchedState === "function" &&
          manualWatchedState(i._id, season, episode) === true))
    ) {
      return true;
    }
    return false;
  }
  const local = resumeForItem(i)?.ms ?? 0;
  if (local <= 0) return false;
  if (duration > 0 && local / duration >= CW_FINISHED_RATIO) return false;
  return true;
}

async function call<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: { error?: { message?: string }; result?: unknown };
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`stremio ${path} ${res.status}: invalid response`);
  }
  if (json.error) throw new Error(json.error.message ?? "Request failed");
  if (!res.ok) throw new Error(`stremio ${path} failed (${res.status})`);
  return json.result as T;
}

export function login(email: string, password: string) {
  return call<{ authKey: string; user: User }>("login", {
    email,
    password,
    facebook: false,
  });
}

export function getUser(authKey: string) {
  return call<User>("getUser", { authKey });
}

export function logout(authKey: string) {
  return call<unknown>("logout", { authKey });
}

export async function library(authKey: string): Promise<LibraryItem[]> {
  const ids = await call<Array<[string, string]>>("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });
  if (!ids?.length) return [];
  return call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: ids.map(([id]) => id),
    all: true,
  });
}

const LIBRARY_FORCE_REFETCH_MS = 300_000;
let libraryCache: { authKey: string; sig: string; at: number; items: LibraryItem[] } | null = null;

export async function libraryIfChanged(authKey: string): Promise<LibraryItem[]> {
  const ids = await call<Array<[string, string]>>("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });
  if (!ids?.length) {
    libraryCache = null;
    return [];
  }
  const sig = ids
    .map(([id, mtime]) => `${id}:${mtime}`)
    .sort()
    .join("|");
  const hit =
    libraryCache &&
    libraryCache.authKey === authKey &&
    libraryCache.sig === sig &&
    Date.now() - libraryCache.at < LIBRARY_FORCE_REFETCH_MS;
  if (hit) return libraryCache!.items;
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: ids.map(([id]) => id),
    all: true,
  });
  libraryCache = { authKey, sig, at: Date.now(), items };
  return items;
}

export function invalidateLibraryCache(): void {
  libraryCache = null;
}

export async function libraryGetOne(authKey: string, id: string): Promise<LibraryItem | null> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [id],
    all: false,
  }).catch(() => [] as LibraryItem[]);
  return items?.find((it) => it._id === id) ?? null;
}

export async function libraryGetOneStrict(
  authKey: string,
  id: string,
): Promise<LibraryItem | null> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [id],
    all: false,
  });
  return items?.find((it) => it._id === id) ?? null;
}

function readPrimaryStremioAuthKey(): string | null {
  try {
    const raw = localStorage.getItem("harbor.profiles.v1");
    if (raw) {
      const state = JSON.parse(raw) as { profiles?: any[]; activeId?: string | null };
      const profiles = Array.isArray(state.profiles) ? state.profiles : [];
      const active =
        profiles.find((p) => p.id === state.activeId) ??
        profiles.find((p) => p.isPrimary) ??
        profiles[0] ??
        null;
      const sourceId = active?.shareStremioWith || active?.id || "default";
      const sessRaw =
        localStorage.getItem(`harbor.auth.${sourceId}`) ||
        localStorage.getItem("harbor.auth.default");
      if (sessRaw) {
        const sess = JSON.parse(sessRaw);
        if (sess?.authKey) return sess.authKey;
      }
      for (const p of profiles) {
        const pSessRaw = localStorage.getItem(`harbor.auth.${p.id}`);
        if (pSessRaw) {
          const sess = JSON.parse(pSessRaw);
          if (sess?.authKey) return sess.authKey;
        }
      }
    }
    const def = localStorage.getItem("harbor.auth.default");
    if (def) {
      const sess = JSON.parse(def);
      if (sess?.authKey) return sess.authKey;
    }
    return null;
  } catch {
    return null;
  }
}

export async function libraryPut(
  authKey: string,
  item: LibraryItem,
  forceAllow = false,
): Promise<void> {
  if (isNuvioProviderActive() && !forceAllow) return;
  if (ANIME_CLOUD_ID.test(item._id) && item.removed !== true) return;
  await call<unknown>("datastorePut", {
    authKey,
    collection: "libraryItem",
    changes: [item],
  });
}

export async function removeStremioLibraryItem(
  authKey: string,
  id: string,
  forceAllow = false,
): Promise<void> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [id],
    all: false,
  });
  const item = items?.find((it) => it._id === id);
  if (!item) return;
  await libraryPut(
    authKey,
    {
      ...item,
      removed: true,
      temp: false,
      _mtime: new Date().toISOString(),
      state: {
        duration: item.state?.duration ?? 0,
        ...item.state,
        timeOffset: 0,
        video_id: undefined,
        flaggedWatched: 0,
      },
    },
    forceAllow,
  );
}

const EXPUNGE_TARGETS_KEY = "harbor.stremio.expunge-targets.v1";

function readExpungeTargets(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPUNGE_TARGETS_KEY) ?? "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeExpungeTargets(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(EXPUNGE_TARGETS_KEY);
    else localStorage.setItem(EXPUNGE_TARGETS_KEY, JSON.stringify([...ids]));
  } catch {}
}

function purgeQueuedWritesFor(targetIds: Set<string>): void {
  if (targetIds.size === 0) return;
  try {
    const rawQ = localStorage.getItem("harbor.stremio.write-queue.v1");
    if (!rawQ) return;
    const q = JSON.parse(rawQ);
    if (!Array.isArray(q)) return;
    const filtered = q.filter((entry: any) => !targetIds.has(entry?.item?._id));
    localStorage.setItem("harbor.stremio.write-queue.v1", JSON.stringify(filtered));
  } catch {}
}

export async function expungeLeachedNuvioItemsFromStremio(
  authKey?: string | null,
  leachedIds: string[] = [],
): Promise<void> {
  const nuvioActive = isNuvioProviderActive();
  const targetIds = new Set<string>(leachedIds);

  if (nuvioActive) {
    try {
      for (const id of collectAllNuvioItemIds()) {
        targetIds.add(id);
      }
    } catch {}
  }

  try {
    sanitizeStremioLocalCw();
  } catch {}

  if (nuvioActive) {
    // Stremio cloud writes are sealed during a Nuvio session, so record the
    // targets and delete them once the Stremio provider is active again.
    if (targetIds.size > 0) {
      const queued = readExpungeTargets();
      let changed = false;
      for (const id of targetIds) {
        if (queued.has(id)) continue;
        queued.add(id);
        changed = true;
      }
      if (changed) writeExpungeTargets(queued);
    }
    purgeQueuedWritesFor(targetIds);
    invalidateLibraryCache();
    return;
  }

  const queued = readExpungeTargets();
  for (const id of targetIds) queued.add(id);
  if (queued.size === 0) {
    invalidateLibraryCache();
    return;
  }

  const ak = authKey || readPrimaryStremioAuthKey();
  if (!ak) {
    writeExpungeTargets(queued);
    invalidateLibraryCache();
    return;
  }

  const failed = new Set<string>();
  for (const id of queued) {
    if (isNuvioProviderActive()) {
      failed.add(id);
      continue;
    }
    try {
      await removeStremioLibraryItem(ak, id, false);
    } catch {
      failed.add(id);
    }
  }
  writeExpungeTargets(failed);
  invalidateLibraryCache();
}

export const CLOUD_OK = /^(tt\d|kitsu:|mal:|anilist:|anidb:|tmdb:)/;

export const ANIME_CLOUD_ID = /^(kitsu|mal|anilist|anidb):/;
export function cloudWriteId(
  metaId: string,
  resolved: string | null,
  verified: boolean,
): string | null {
  if (metaId.startsWith("tt")) return metaId;
  if (ANIME_CLOUD_ID.test(metaId)) return null;
  if (verified && resolved && resolved.startsWith("tt")) return resolved;
  return CLOUD_OK.test(metaId) ? metaId : null;
}

export async function saveStremioBookmark(
  authKey: string,
  id: string,
  input: { type?: string; name?: string; poster?: string },
  strict = false,
): Promise<void> {
  if (isNuvioProviderActive()) return;
  const now = new Date().toISOString();
  let existing: LibraryItem | null;
  try {
    existing = await libraryGetOneStrict(authKey, id);
  } catch (error) {
    if (strict) throw error;
    return;
  }
  if (existing) {
    await libraryPut(authKey, { ...existing, removed: false, temp: false, _mtime: now });
    return;
  }
  const type =
    input.type === "series" || input.type === "tv" || input.type === "channel" ? "series" : "movie";
  const item = {
    _id: id,
    name: input.name ?? "",
    type,
    poster: input.poster ?? null,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      lastVidReleased: null,
      noNotif: false,
    },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
  };
  await libraryPut(authKey, item as unknown as LibraryItem);
}

export async function removeStremioBookmark(
  authKey: string,
  id: string,
  _strict = true,
): Promise<void> {
  if (isNuvioProviderActive()) return;
  const existing = await libraryGetOneStrict(authKey, id);
  if (!existing || existing.removed) return;
  await libraryPut(authKey, {
    ...existing,
    removed: true,
    // Removing a bookmark keeps playback/history, like a title watched without saving it.
    // Explicit History removal still uses removeStremioLibraryItem's full tombstone.
    temp: true,
    _mtime: new Date().toISOString(),
  });
}
