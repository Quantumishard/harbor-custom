import { useEffect, useSyncExternalStore } from "react";
import { noteNotify } from "@/lib/render-cause";
import { detectAnimeForCw } from "@/lib/anime-detect";
import {
  clearCachedSimklPlaybackItems,
  fetchSimklPlaybackItems,
  readCachedSimklPlaybackItems,
} from "@/lib/simkl/playback";
import {
  clearCachedTraktPlaybackItems,
  fetchTraktPlaybackItems,
  readCachedTraktPlaybackItems,
} from "@/lib/trakt/playback";
import {
  fetchNuvioPlaybackItems,
  readCachedNuvioPlaybackItems,
  writeCachedNuvioPlaybackItems,
} from "@/lib/nuvio/nuvio-playback";
import { getNuvioAccountId, isNuvioSignedIn } from "@/lib/nuvio/nuvio-client";
import {
  isNuvioProviderActive,
  resolveNuvioProfileIndex,
  getNuvioContentIdVariants,
} from "@/lib/nuvio/nuvio-sync";
import {
  getSession as getSimklSession,
  subscribeSession as subscribeSimklSession,
} from "@/lib/simkl/session";
import {
  getSession as getTraktSession,
  subscribeSession as subscribeTraktSession,
} from "@/lib/trakt/session";
import { fetchPublicMetaDbPlaybackItems } from "@/lib/publicmetadb/playback";
import {
  getSession as getPmdbSession,
  subscribeSession as subscribePmdbSession,
} from "@/lib/publicmetadb/session";
import { type LibraryItem } from "@/lib/stremio";
import { startupEvent } from "@/lib/startup-trace";
import { TRACKER_PROGRESS_EVENT } from "@/lib/tracker-progress-events";

const STALE_MS = 300_000;
const FOCUS_STALE_MS = 30_000;
const RETRY_DELAYS_MS = [1000, 4000, 10000];
const EMPTY: LibraryItem[] = [];

type ProviderResult = { items: LibraryItem[]; fresh: boolean };

// Per-slot in-memory cache for snappy instant profile switches
const slotCwMemoryCache = new Map<number, LibraryItem[]>();

export function clearNuvioCwMemoryCache(): void {
  slotCwMemoryCache.clear();
}

export function getCachedNuvioItemsForSlot(slot: number): LibraryItem[] {
  const mem = slotCwMemoryCache.get(slot);
  if (mem && mem.length > 0) return mem;
  const disk = readCachedNuvioPlaybackItems(slot);
  if (disk && disk.length > 0) {
    slotCwMemoryCache.set(slot, disk);
    return disk;
  }
  return [];
}

let sourceMask = { trakt: true, simkl: true, publicmetadb: false, nuvio: isNuvioProviderActive() };

function activityOf(i: LibraryItem): number {
  const lw = Date.parse(i.state?.lastWatched ?? "");
  if (Number.isFinite(lw)) return lw;
  const m = Date.parse(i._mtime ?? "");
  return Number.isFinite(m) ? m : 0;
}

function mergeItem(existing: LibraryItem, incoming: LibraryItem): LibraryItem {
  const isExistingNuvio = existing.external === "nuvio";
  const isIncomingNuvio = incoming.external === "nuvio";

  if (isExistingNuvio && !isIncomingNuvio) {
    if (activityOf(incoming) > activityOf(existing)) {
      return {
        ...existing,
        state: {
          ...existing.state,
          ...incoming.state,
          video_id: incoming.state?.video_id ?? existing.state?.video_id,
          season: incoming.state?.season ?? existing.state?.season,
          episode: incoming.state?.episode ?? existing.state?.episode,
          timeOffset: incoming.state?.timeOffset ?? existing.state?.timeOffset ?? 0,
          duration: incoming.state?.duration ?? existing.state?.duration ?? 0,
          lastWatched: incoming.state?.lastWatched ?? existing.state?.lastWatched,
        },
        _mtime: incoming._mtime ?? existing._mtime,
      };
    }
    return existing;
  }

  if (!isExistingNuvio && isIncomingNuvio) {
    if (activityOf(existing) > activityOf(incoming)) {
      return {
        ...incoming,
        state: {
          ...incoming.state,
          ...existing.state,
          video_id: existing.state?.video_id ?? incoming.state?.video_id,
          season: existing.state?.season ?? incoming.state?.season,
          episode: existing.state?.episode ?? incoming.state?.episode,
          timeOffset: existing.state?.timeOffset ?? incoming.state?.timeOffset ?? 0,
          duration: existing.state?.duration ?? incoming.state?.duration ?? 0,
          lastWatched: existing.state?.lastWatched ?? incoming.state?.lastWatched,
        },
        _mtime: existing._mtime ?? incoming._mtime,
      };
    }
    return incoming;
  }

  return activityOf(incoming) > activityOf(existing) ? incoming : existing;
}

function isEligibleTrackerPlayback(i: LibraryItem): boolean {
  if (i.external !== "simkl" && i.external !== "trakt" && i.external !== "publicmetadb") {
    return true;
  }
  if (i.upNext || i.waitingForAir) return true;
  const offset = i.state?.timeOffset ?? 0;
  const dur = i.state?.duration ?? 0;
  if (offset <= 0 || (i.state?.flaggedWatched ?? 0) > 0) return false;
  if (dur > 0 && offset / dur >= 0.9) return false;
  return true;
}

function merge(lists: LibraryItem[][]): LibraryItem[] {
  const byId = new Map<string, LibraryItem>();
  for (const list of lists) {
    for (const i of list) {
      if (!isEligibleTrackerPlayback(i)) continue;
      const held = byId.get(i._id);
      if (!held) {
        byId.set(i._id, i);
      } else {
        const next = mergeItem(held, i);
        // A provider's playback id belongs to one episode. Do not let a deduped
        // show carry a different episode's id from another source.
        const sameEpisode =
          held.state?.season === i.state?.season && held.state?.episode === i.state?.episode;
        const ids = sameEpisode
          ? { ...held.providerPlaybackIds, ...i.providerPlaybackIds }
          : next.providerPlaybackIds;
        if (ids && Object.keys(ids).length > 0) next.providerPlaybackIds = ids;
        byId.set(i._id, next);
      }
    }
  }
  return [...byId.values()].sort((a, b) => activityOf(b) - activityOf(a));
}

// Pre-populate items synchronously on module load from disk cache
const cacheReadStartedAt = typeof performance !== "undefined" ? performance.now() : 0;
startupEvent("cw.cache.read.start", {});
let items: LibraryItem[] = (() => {
  if (typeof window === "undefined") return EMPTY;
  const initialLists: LibraryItem[][] = [];
  const readCache = (source: string, read: () => LibraryItem[]): LibraryItem[] => {
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    const value = read();
    if (typeof performance !== "undefined") {
      startupEvent("cw.cache.source", {
        source,
        ms: Math.round((performance.now() - started) * 10) / 10,
        items: value.length,
      });
    }
    return value;
  };
  if (isNuvioSignedIn() && isNuvioProviderActive()) {
    try {
      const slot = resolveNuvioProfileIndex();
      const initial = readCache("nuvio", () => getCachedNuvioItemsForSlot(slot));
      if (initial.length > 0) initialLists.push(initial);
    } catch {}
  }
  if (typeof readCachedTraktPlaybackItems === "function" && getTraktSession() && sourceMask.trakt) {
    try {
      const initialTrakt = readCache("trakt", readCachedTraktPlaybackItems);
      if (initialTrakt && initialTrakt.length > 0) initialLists.push(initialTrakt);
    } catch {}
  }
  if (typeof readCachedSimklPlaybackItems === "function" && getSimklSession() && sourceMask.simkl) {
    try {
      const initialSimkl = readCache("simkl", readCachedSimklPlaybackItems);
      if (initialSimkl && initialSimkl.length > 0) initialLists.push(initialSimkl);
    } catch {}
  }
  return initialLists.length > 0 ? merge(initialLists) : EMPTY;
})();
if (typeof performance !== "undefined") {
  startupEvent("cw.cache.read.end", {
    ms: Math.round((performance.now() - cacheReadStartedAt) * 10) / 10,
    items: items.length,
  });
  startupEvent("cw.cache.ready", { items: items.length });
}

let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let followUp: Promise<void> | null = null;
let inflightOwner: unknown[] | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let refreshGen = 0;
let lastAppliedGen = 0;
const subs = new Set<() => void>();

function emit(): void {
  noteNotify("store:external-cw");
  for (const fn of subs) fn();
}

function setItems(next: LibraryItem[]): void {
  if (next.length === 0 && items.length === 0) return;
  if (next === items) return;
  try {
    // Conservative content check: false negatives only cost an extra emit.
    if (JSON.stringify(items) === JSON.stringify(next)) return;
  } catch {}
  items = next;
  emit();
  void detectAnimeForCw(next.filter((item) => !item.isAnime));
}

export function willRefreshExternalCw(force = false): boolean {
  if (!isNuvioSignedIn() || !isNuvioProviderActive() || sourceMask.nuvio === false) return false;
  if (!externalCwConnected()) return false;
  if (inflight) return true;
  if (force) return true;
  return !(fetchedAt > 0 && Date.now() - fetchedAt < STALE_MS);
}

export function externalCwConnected(): boolean {
  const nuvioActive = isNuvioProviderActive() && isNuvioSignedIn() && sourceMask.nuvio !== false;
  return (
    (sourceMask.simkl && !!getSimklSession()) ||
    (sourceMask.trakt && !!getTraktSession()) ||
    (sourceMask.publicmetadb && !!getPmdbSession()) ||
    nuvioActive
  );
}

export function setExternalCwSources(mask: {
  trakt: boolean;
  simkl: boolean;
  publicmetadb?: boolean;
  nuvio?: boolean;
}): void {
  const pm = mask.publicmetadb ?? sourceMask.publicmetadb;
  const nuvio = mask.nuvio !== undefined ? mask.nuvio : isNuvioProviderActive();
  if (
    mask.trakt === sourceMask.trakt &&
    mask.simkl === sourceMask.simkl &&
    pm === sourceMask.publicmetadb &&
    nuvio === sourceMask.nuvio
  )
    return;

  sourceMask = { trakt: mask.trakt, simkl: mask.simkl, publicmetadb: pm, nuvio };
  fetchedAt = 0;

  // Drop items from newly-disabled sources synchronously so their cards vanish
  // immediately instead of lingering until the next successful refresh.
  let nextItems = items;
  if (items.length > 0) {
    const kept = items.filter(
      (i) =>
        (sourceMask.trakt || i.external !== "trakt") &&
        (sourceMask.simkl || i.external !== "simkl") &&
        (sourceMask.publicmetadb || i.external !== "publicmetadb") &&
        (sourceMask.nuvio || i.external !== "nuvio"),
    );
    if (kept.length !== items.length) {
      nextItems = kept;
    }
  }

  // Pre-load cached items synchronously from enabled sources if currently missing
  const hasTraktInItems = nextItems.some((i) => i.external === "trakt");
  const hasSimklInItems = nextItems.some((i) => i.external === "simkl");
  const hasNuvioInItems = nextItems.some((i) => i.external === "nuvio");

  const toAdd: LibraryItem[][] = [];
  if (
    sourceMask.trakt &&
    !hasTraktInItems &&
    typeof readCachedTraktPlaybackItems === "function" &&
    getTraktSession()
  ) {
    try {
      const c = readCachedTraktPlaybackItems();
      if (c && c.length > 0) toAdd.push(c);
    } catch {}
  }
  if (
    sourceMask.simkl &&
    !hasSimklInItems &&
    typeof readCachedSimklPlaybackItems === "function" &&
    getSimklSession()
  ) {
    try {
      const c = readCachedSimklPlaybackItems();
      if (c && c.length > 0) toAdd.push(c);
    } catch {}
  }
  if (sourceMask.nuvio && !hasNuvioInItems && isNuvioSignedIn() && isNuvioProviderActive()) {
    try {
      const slot = resolveNuvioProfileIndex();
      const c = getCachedNuvioItemsForSlot(slot);
      if (c && c.length > 0) toAdd.push(c);
    } catch {}
  }
  if (toAdd.length > 0) {
    nextItems = merge([nextItems, ...toAdd]);
  }

  if (nextItems !== items) {
    setItems(nextItems);
  }

  if (!externalCwConnected()) setItems(EMPTY);
  // Only the source set changed; the in-flight request already covers this owner.
  void refreshExternalCw(true, "owner");
}

async function runRefresh(
  gen: number,
  force = false,
  ownerAtStart: unknown[] = refreshOwner(),
): Promise<boolean> {
  const enabled: Array<{
    source: "simkl" | "trakt" | "publicmetadb" | "nuvio";
    fetch: (force: boolean) => Promise<ProviderResult>;
  }> = [];
  if (getSimklSession() && sourceMask.simkl)
    enabled.push({ source: "simkl", fetch: fetchSimklPlaybackItems });
  if (getTraktSession() && sourceMask.trakt)
    enabled.push({ source: "trakt", fetch: fetchTraktPlaybackItems });
  if (getPmdbSession() && sourceMask.publicmetadb)
    enabled.push({ source: "publicmetadb", fetch: fetchPublicMetaDbPlaybackItems });
  if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
    enabled.push({
      source: "nuvio",
      fetch: async (refresh) => {
        const slot = resolveNuvioProfileIndex();
        const result = await fetchNuvioPlaybackItems(slot, refresh);
        // An older account's response must not repopulate the slot cache after
        // an account switch, even when both accounts use the same slot.
        if (sameRefreshOwner(ownerAtStart, refreshOwner()))
          slotCwMemoryCache.set(slot, result.items);
        return result;
      },
    });
  }

  startupEvent("cw.external.refresh.start", {
    sources: enabled.map(({ source }) => source),
  });
  const results = await Promise.all(
    enabled.map(async ({ source, fetch }) => {
      const started = typeof performance !== "undefined" ? performance.now() : 0;
      try {
        const value = await fetch(force);
        startupEvent("cw.external.source", {
          source,
          ok: true,
          fresh: value.fresh,
          ms: Math.round((performance.now() - started) * 10) / 10,
        });
        return value;
      } catch {
        startupEvent("cw.external.source", {
          source,
          ok: false,
          fresh: false,
          ms: Math.round((performance.now() - started) * 10) / 10,
        });
        return null;
      }
    }),
  );

  const complete = results.every((result) => result !== null && result.fresh);
  const failedSources = new Set(
    enabled.filter((_, index) => results[index] === null).map(({ source }) => source),
  );
  const staleSources = new Set(
    enabled
      .filter((_, index) => {
        const result = results[index];
        return result !== null && !result.fresh;
      })
      .map(({ source }) => source),
  );
  startupEvent("cw.external.refresh.end", {
    complete,
    succeeded: results.filter((result) => result !== null).length,
    failed: [...failedSources],
    stale: [...staleSources],
    superseded: gen < lastAppliedGen,
  });

  // If a newer generation has already finished and applied, ignore this superseded run
  if (gen < lastAppliedGen) return true;
  // The account, profile or enabled sources changed while this request ran: the
  // change already cleared those cards and queued a follow-up, so publishing now
  // would put the previous owner's data back on screen.
  if (!sameRefreshOwner(ownerAtStart, refreshOwner())) return true;
  lastAppliedGen = gen;

  fetchedAt = complete ? Date.now() : 0;
  const succeeded = results.filter((result): result is ProviderResult => result !== null);
  if (succeeded.length === 0) return false;
  // A stale cache is shown, but the previous source rows are retained so an
  // empty stale fallback cannot erase the last good row.
  const retainedSources = new Set([...failedSources, ...staleSources]);
  const retained = items.filter((i) => i.external && retainedSources.has(i.external));
  const activeItems = [...succeeded.flatMap((result) => result.items), ...retained].filter((i) => {
    if (i.external === "trakt") return sourceMask.trakt && !!getTraktSession();
    if (i.external === "simkl") return sourceMask.simkl && !!getSimklSession();
    if (i.external === "publicmetadb") return sourceMask.publicmetadb && !!getPmdbSession();
    if (i.external === "nuvio")
      return sourceMask.nuvio && isNuvioSignedIn() && isNuvioProviderActive();
    return true;
  });
  setItems(merge([activeItems]));
  if (complete) retryAttempt = 0;
  return complete;
}

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryAttempt = 0;
}

// Account/profile identity a refresh was started for. Session objects change
// identity on an account switch; a response captured under one identity must
// never be applied to another, even for the interval before the follow-up runs.
// "data" (the default for forced calls) means fresh data was requested and must
// be fetched even when the same owner is already being fetched; "owner" is a
// revalidation triggered by an owner event, which the in-flight request covers.
type RefreshCause = "owner" | "data";

function refreshOwner(): unknown[] {
  return [
    getSimklSession(),
    getTraktSession(),
    getPmdbSession(),
    isNuvioSignedIn() && isNuvioProviderActive() ? resolveNuvioProfileIndex() : null,
    isNuvioSignedIn() && isNuvioProviderActive() ? getNuvioAccountId() : null,
    sourceMask.trakt,
    sourceMask.simkl,
    sourceMask.publicmetadb,
    sourceMask.nuvio,
  ];
}

function sameRefreshOwner(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function scheduleRetry(force = false): void {
  if (retryTimer !== null) return;
  if (retryAttempt >= RETRY_DELAYS_MS.length) return;
  const gen = refreshGen;
  const delay = RETRY_DELAYS_MS[retryAttempt];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (gen === refreshGen) void startRefresh(gen, force);
  }, delay);
}

function startRefresh(gen: number, force = false): Promise<void> {
  const owner = refreshOwner();
  inflightOwner = owner;
  inflight = runRefresh(gen, force, owner)
    .then((ok) => {
      if (gen === refreshGen && !ok) scheduleRetry(force);
    })
    .finally(() => {
      inflight = null;
      inflightOwner = null;
    });
  return inflight;
}

export function refreshExternalCw(force = false, cause: RefreshCause = "data"): Promise<void> {
  if (!externalCwConnected()) {
    refreshGen += 1;
    cancelRetry();
    fetchedAt = 0;
    setItems(EMPTY);
    return Promise.resolve();
  }
  if (inflight) {
    if (!force) return inflight;
    // A forced owner refresh for the owner already being fetched would refetch
    // what is arriving: the response is valid for it either way.
    if (cause === "owner" && inflightOwner && sameRefreshOwner(inflightOwner, refreshOwner()))
      return inflight;
    // Don't kill the active in-flight request: let it deliver, then run one more.
    // Several forced callers (session, profile and provider events) land during
    // the same request; each must not queue its own refetch.
    followUp ??= inflight.then(() => {
      followUp = null;
      return refreshExternalCw(true, cause);
    });
    return followUp;
  }
  if (!force && fetchedAt > 0 && Date.now() - fetchedAt < STALE_MS) return Promise.resolve();
  cancelRetry();
  return startRefresh(++refreshGen, force);
}

function matchesContentId(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = a.replace(/^(series|movie|tmdb|tmdb:tv|tmdb:movie):/, "").trim();
  const cb = b.replace(/^(series|movie|tmdb|tmdb:tv|tmdb:movie):/, "").trim();
  if (ca && ca === cb) return true;
  const va = getNuvioContentIdVariants(a);
  return va.includes(b) || (!!cb && va.includes(cb));
}

export function removeExternalCwItem(item: LibraryItem): void {
  items = items.filter((i) => !matchesContentId(i._id, item._id));

  if (item.external === "nuvio" || (isNuvioSignedIn() && isNuvioProviderActive())) {
    try {
      const slot = resolveNuvioProfileIndex();
      const cur = slotCwMemoryCache.get(slot) || [];
      slotCwMemoryCache.set(
        slot,
        cur.filter((i) => !matchesContentId(i._id, item._id)),
      );
      const disk = readCachedNuvioPlaybackItems(slot);
      const filteredDisk = disk.filter((i) => !matchesContentId(i._id, item._id));
      writeCachedNuvioPlaybackItems(slot, filteredDisk);
    } catch {}
  }
  emit();
}

export function subscribeExternalCw(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function listExternalCw(): LibraryItem[] {
  return items;
}

let lastSimkl = getSimklSession();
let lastTrakt = getTraktSession();
let lastPmdb = getPmdbSession();
let lastNuvio = isNuvioSignedIn() && isNuvioProviderActive();
let lastNuvioAccount = lastNuvio ? getNuvioAccountId() : null;

function onSessionChange(): void {
  slotCwMemoryCache.clear();
  sourceMask.nuvio = isNuvioProviderActive();
  const simkl = getSimklSession();
  const trakt = getTraktSession();
  const pmdb = getPmdbSession();
  const nuvio = isNuvioSignedIn() && isNuvioProviderActive();
  const nuvioAccount = nuvio ? getNuvioAccountId() : null;
  if (
    simkl === lastSimkl &&
    trakt === lastTrakt &&
    pmdb === lastPmdb &&
    nuvio === lastNuvio &&
    nuvioAccount === lastNuvioAccount
  )
    return;
  const previousSimklUser = lastSimkl?.username?.trim().toLowerCase() ?? null;
  const nextSimklUser = simkl?.username?.trim().toLowerCase() ?? null;
  if (previousSimklUser && previousSimklUser !== nextSimklUser)
    clearCachedSimklPlaybackItems(previousSimklUser);
  const previousTraktUser = lastTrakt?.username?.trim().toLowerCase() ?? null;
  const nextTraktUser = trakt?.username?.trim().toLowerCase() ?? null;
  if (previousTraktUser && previousTraktUser !== nextTraktUser)
    clearCachedTraktPlaybackItems(previousTraktUser);
  setItems(
    items.filter(
      (i) =>
        (i.external !== "simkl" || simkl === lastSimkl) &&
        (i.external !== "trakt" || trakt === lastTrakt) &&
        (i.external !== "publicmetadb" || pmdb === lastPmdb) &&
        (i.external !== "nuvio" || (nuvio === lastNuvio && nuvioAccount === lastNuvioAccount)),
    ),
  );
  lastSimkl = simkl;
  lastTrakt = trakt;
  lastPmdb = pmdb;
  lastNuvio = nuvio;
  lastNuvioAccount = nuvioAccount;
  fetchedAt = 0;
  if (!externalCwConnected()) {
    cancelRetry();
    setItems(EMPTY);
    return;
  }
  // Every identity that can change this data changed; a request already running
  // for the same owner covers it.
  void refreshExternalCw(true, "owner");
}

function onProfileChange(): void {
  sourceMask.nuvio = isNuvioProviderActive();
  lastSimkl = getSimklSession();
  lastTrakt = getTraktSession();
  lastPmdb = getPmdbSession();
  lastNuvio = isNuvioSignedIn() && isNuvioProviderActive();
  const nuvioAccount = lastNuvio ? getNuvioAccountId() : null;
  if (nuvioAccount !== lastNuvioAccount) clearNuvioCwMemoryCache();
  lastNuvioAccount = nuvioAccount;
  fetchedAt = 0;

  if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
    const currentSlot = resolveNuvioProfileIndex();
    const cached = getCachedNuvioItemsForSlot(currentSlot);
    if (cached.length > 0) {
      setItems(cached);
    } else {
      const built = readCachedNuvioPlaybackItems(currentSlot);
      if (built.length > 0) {
        slotCwMemoryCache.set(currentSlot, built);
        setItems(built);
      } else {
        setItems(EMPTY);
      }
    }
  } else {
    setItems(items.filter((i) => i.external !== "nuvio"));
  }

  // Profile/source changes are all in the owner snapshot; skip a duplicate
  // fetch when the same owner is already being fetched.
  void refreshExternalCw(true, "owner");
}

if (typeof window !== "undefined") {
  subscribeSimklSession(onSessionChange);
  subscribeTraktSession(onSessionChange);
  subscribePmdbSession(onSessionChange);
  window.addEventListener("harbor:active-profile-changed", onProfileChange);
  window.addEventListener("harbor:profiles-updated", onProfileChange);
  window.addEventListener("harbor:nuvio-state-changed", () => {
    clearNuvioCwMemoryCache();
    onSessionChange();
    void refreshExternalCw(true, "owner");
  });
  window.addEventListener("harbor:account-provider-changed", () => {
    clearNuvioCwMemoryCache();
    onSessionChange();
    void refreshExternalCw(true);
  });
  window.addEventListener("harbor:nuvio-profile-changed", onProfileChange);
  window.addEventListener("harbor:nuvio-profiles-updated", () => {
    void refreshExternalCw(false);
  });
  window.addEventListener("harbor:account-provider-changed", onProfileChange);
  window.addEventListener("harbor:playback-session-ended", () => {
    if (!isNuvioProviderActive()) return;
    // Progress changed upstream under the same account: fetch again even if a
    // request is already running.
    void refreshExternalCw(true, "data");
  });
  window.addEventListener("harbor:nuvio-progress-pushed", (e) => {
    if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
      const detail = (e as CustomEvent)?.detail;
      const slot =
        typeof detail?.profileIndex === "number" ? detail.profileIndex : resolveNuvioProfileIndex();
      const current = resolveNuvioProfileIndex();
      if (slot === current) {
        const fresh = readCachedNuvioPlaybackItems(slot);
        if (fresh.length > 0) {
          slotCwMemoryCache.set(slot, fresh);
          const nonNuvio = items.filter((i) => i.external !== "nuvio");
          setItems(merge([fresh, nonNuvio]));
        }
      }
    }
    void refreshExternalCw(false);
  });
  window.addEventListener("harbor:nuvio-progress-deleted", (e) => {
    if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
      const detail = (e as CustomEvent)?.detail;
      if (detail?.episodeOnly) return;
      const slot =
        typeof detail?.profileIndex === "number" ? detail.profileIndex : resolveNuvioProfileIndex();
      const current = resolveNuvioProfileIndex();
      if (slot === current) {
        const contentId = detail?.contentId;
        if (contentId) {
          items = items.filter((i) => !matchesContentId(i._id, contentId));
          const curMem = slotCwMemoryCache.get(slot) || [];
          slotCwMemoryCache.set(
            slot,
            curMem.filter((i) => !matchesContentId(i._id, contentId)),
          );
          emit();
        }
        const fresh = readCachedNuvioPlaybackItems(slot).filter(
          (i) => !contentId || !matchesContentId(i._id, contentId),
        );
        slotCwMemoryCache.set(slot, fresh);
        const nonNuvio = items.filter(
          (i) => i.external !== "nuvio" && (!contentId || !matchesContentId(i._id, contentId)),
        );
        setItems(merge([fresh, nonNuvio]));
      }
    }
  });
  window.addEventListener("harbor:nuvio-progress-reconciled", (e) => {
    if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
      const detail = (e as CustomEvent)?.detail;
      const slot =
        typeof detail?.profileIndex === "number" ? detail.profileIndex : resolveNuvioProfileIndex();
      const current = resolveNuvioProfileIndex();
      if (slot === current) {
        const fresh = readCachedNuvioPlaybackItems(slot);
        slotCwMemoryCache.set(slot, fresh);
        const nonNuvio = items.filter((i) => i.external !== "nuvio");
        setItems(merge([fresh, nonNuvio]));
      }
    }
  });
  window.addEventListener("harbor:continue-watching-updated", () => {
    if (isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
      const slot = resolveNuvioProfileIndex();
      const fresh = readCachedNuvioPlaybackItems(slot);
      slotCwMemoryCache.set(slot, fresh);
      const nonNuvio = items.filter((i) => i.external !== "nuvio");
      setItems(merge([fresh, nonNuvio]));
    }
  });
  window.addEventListener(TRACKER_PROGRESS_EVENT, () => {
    // A tracker confirmed new watched progress; refetch immediately instead of
    // waiting for the next poll. The refresh generation drops any older
    // in-flight response that started before the completion.
    void refreshExternalCw(true, "data");
  });
}

export function useExternalCw(enabled = true): LibraryItem[] {
  const snapshot = useSyncExternalStore(subscribeExternalCw, listExternalCw, listExternalCw);
  useEffect(() => {
    if (!enabled) return;
    if (items.length === 0 && isNuvioSignedIn() && sourceMask.nuvio && isNuvioProviderActive()) {
      try {
        const slot = resolveNuvioProfileIndex();
        const cached = getCachedNuvioItemsForSlot(slot);
        if (cached.length > 0) {
          const nonNuvio = items.filter((i) => i.external !== "nuvio");
          setItems(merge([cached, nonNuvio]));
        }
      } catch {}
    }
    onSessionChange();
    if (isNuvioSignedIn() && isNuvioProviderActive()) {
      const fresh = fetchedAt > 0 && Date.now() - fetchedAt < STALE_MS;
      void refreshExternalCw(!fresh);
    } else {
      void refreshExternalCw();
    }
    // Nuvio periodic and focus refreshes are owned by the app-level sync
    // coordinator so multiple mounted views cannot stack 30s polls.
    const nuvioMode = () => isNuvioSignedIn() && isNuvioProviderActive();
    const onFocus = (): void => {
      if (nuvioMode()) return;
      if (Date.now() - fetchedAt > FOCUS_STALE_MS) void refreshExternalCw(true);
      else void refreshExternalCw();
    };
    const onVisible = (): void => {
      if (document.visibilityState !== "visible" || nuvioMode()) return;
      if (Date.now() - fetchedAt > FOCUS_STALE_MS) void refreshExternalCw(true);
      else void refreshExternalCw();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, STALE_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [enabled]);
  return enabled ? snapshot : EMPTY;
}
