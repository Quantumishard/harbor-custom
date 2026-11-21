import { useSyncExternalStore } from "react";
import { noteNotify } from "@/lib/render-cause";

import { meta as fetchMeta, type Meta } from "@/lib/cinemeta";
import { imdbToKitsu, tmdbTvToKitsu } from "@/lib/providers/anime-mapping";
import { kitsuAnime } from "@/lib/providers/kitsu";
import { setItemWithRecovery } from "@/lib/storage-recovery";
import { tmdbImdbCached, tmdbImdbId } from "@/lib/providers/tmdb/tmdb-imdb-resolve";

const STORAGE_KEY = "harbor.anime.detected.v2";
const NEGATIVE_KEY = "harbor.anime.notanime.v2";
const NEGATIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NEGATIVE_MAX = 1500;
const NEGATIVE_FLUSH_MS = 2000;
const CONCURRENCY = 6;
const EAGER_BUDGET = 24;
const DEFER_MS = 6000;

type DetectItem = { _id: string; type: string };

function load(): Set<string> {
  try {
    localStorage.removeItem("harbor.anime.detected.v1");
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

let negativesSince = 0;

function loadNegatives(): Set<string> {
  try {
    const raw = localStorage.getItem(NEGATIVE_KEY);
    const c = raw ? (JSON.parse(raw) as { t?: number; ids?: string[] } | null) : null;
    if (
      c &&
      typeof c.t === "number" &&
      Date.now() - c.t < NEGATIVE_TTL_MS &&
      Array.isArray(c.ids)
    ) {
      negativesSince = c.t;
      return new Set(c.ids);
    }
  } catch {
    /* ignore */
  }
  negativesSince = Date.now();
  return new Set();
}

const detected = load();
const negatives = loadNegatives();
const checked = new Set<string>();
const pending = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const queue: DetectItem[] = [];
let version = 0;
const listeners = new Set<() => void>();

// A home feed settles dozens of detections in a burst, and each positive used to
// rewrite the whole set synchronously. Positives are now batched like negatives;
// both are flushed when the page goes away so nothing detected is lost.
// A set stays dirty until a write succeeds, so a failed batch is retried by the
// next batch or by the pagehide flush instead of being dropped.
let positiveTimer: ReturnType<typeof setTimeout> | null = null;
let positivesDirty = false;

function writePositives(): void {
  try {
    if (setItemWithRecovery(STORAGE_KEY, JSON.stringify([...detected]))) positivesDirty = false;
  } catch {}
}

function persist(): void {
  positivesDirty = true;
  if (positiveTimer != null) return;
  positiveTimer = setTimeout(() => {
    positiveTimer = null;
    writePositives();
  }, NEGATIVE_FLUSH_MS);
}

let negativeTimer: ReturnType<typeof setTimeout> | null = null;
let negativesDirty = false;

function writeNegatives(): void {
  try {
    const all = [...negatives];
    const ids = all.length > NEGATIVE_MAX ? all.slice(-NEGATIVE_MAX) : all;
    if (setItemWithRecovery(NEGATIVE_KEY, JSON.stringify({ t: negativesSince, ids }))) {
      negativesDirty = false;
    }
  } catch {}
}

function persistNegatives(): void {
  negativesDirty = true;
  if (negativeTimer != null) return;
  negativeTimer = setTimeout(() => {
    negativeTimer = null;
    writeNegatives();
  }, NEGATIVE_FLUSH_MS);
}

function flushPending(): void {
  if (positiveTimer != null) {
    clearTimeout(positiveTimer);
    positiveTimer = null;
  }
  if (positivesDirty) writePositives();
  if (negativeTimer != null) {
    clearTimeout(negativeTimer);
    negativeTimer = null;
  }
  if (negativesDirty) writeNegatives();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushPending);

// Detection settles one title at a time, and each settle used to notify synchronously: a home feed
// with hundreds of anime re-rendered home, discover and every other version consumer once per
// title. Coalescing the notifications makes a burst of settles cost a single re-render.
const BUMP_COALESCE_MS = 120;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

function bump(): void {
  version += 1;
  if (bumpTimer != null) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    noteNotify("store:anime-detect");
    listeners.forEach((l) => l());
  }, BUMP_COALESCE_MS);
}

export function isDetectedAnime(id: string): boolean {
  if (detected.has(id)) return true;
  // A verified external ID link is stronger than a title match. A recognized
  // IMDb entry can be known before its separate TMDB CW record is checked.
  if (!/^tmdb:tv:[1-9]\d*$/.test(id)) return false;
  const imdb = tmdbImdbCached(id);
  return typeof imdb === "string" && /^tt\d+$/.test(imdb) && detected.has(imdb);
}

const ANIME_ID_RE = /^(kitsu|mal|anilist|anidb):/;

export function metaLooksAnime(m: {
  id?: string;
  genres?: string[];
  country?: string;
  originalLanguage?: string;
}): boolean {
  const id = m.id ?? "";
  if (ANIME_ID_RE.test(id)) return true;
  if (detected.has(id)) return true;
  return isJapaneseAnime(m);
}

/**
 * Warm the anime identity resolution for a catalog meta the user is about to
 * open (the search top match): resolve imdb/tmdb -> kitsu and warm the Kitsu
 * lookup the detail page's year verdict needs, so detection answers from cache
 * instead of the series view rendering and then being swapped out.
 */
export function warmAnimeResolution(m: Meta): void {
  if (!metaLooksAnime(m)) return;
  const imdb = m.id.startsWith("tt") ? m.id : null;
  const tmdbTv = /^tmdb:tv:(\d+)$/.exec(m.id);
  if (!imdb && !tmdbTv) return;
  void (async () => {
    let k = tmdbTv ? await tmdbTvToKitsu(Number(tmdbTv[1])).catch(() => null) : null;
    if (k == null && imdb) k = await imdbToKitsu(imdb).catch(() => null);
    if (k != null) await kitsuAnime(k).catch(() => null);
  })();
}

export function detectAnimeForMetas(metas: Array<{ id: string; type?: string }>): void {
  const items = metas
    .filter((m) => /^tt\d+$/.test(m.id) || /^tmdb:tv:\d+$/.test(m.id))
    .map((m) => ({ _id: m.id, type: m.type === "movie" ? "movie" : "series" }));
  if (items.length > 0) void detectAnimeForCw(items);
}

export function useDetectedAnimeVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

function hasAnimationGenre(m: { genres?: string[] }): boolean {
  return (m.genres ?? []).some((g) => {
    const l = g.toLowerCase();
    return l === "animation" || l === "anime";
  });
}

function primaryCountry(m: { country?: string }): string {
  return (m.country ?? "").split(",")[0].trim().toLowerCase();
}

function isJapaneseAnime(m: {
  genres?: string[];
  country?: string;
  originalLanguage?: string;
}): boolean {
  if ((m.genres ?? []).some((g) => g.toLowerCase() === "anime")) return true;
  if (!hasAnimationGenre(m)) return false;
  const c = primaryCountry(m);
  const lang = (m.originalLanguage ?? "").toLowerCase();
  return c.includes("japan") || c === "jp" || c === "jpn" || lang === "ja" || lang === "jpn";
}

export function isOrphanAnimeCandidate(meta: {
  type?: string;
  animeFormat?: string;
  genres?: string[];
  country?: string;
  originalLanguage?: string;
  productionCountries?: string[];
}): boolean {
  if (meta.type === "anime" || !!meta.animeFormat) return true;
  if (!hasAnimationGenre(meta)) return false;

  const lang = (meta.originalLanguage ?? "").toLowerCase();
  const metaCountry = (meta.country ?? "").toLowerCase();
  const countries = (meta.productionCountries ?? []).map((c) => c.toUpperCase());

  return (
    lang === "ja" ||
    lang === "jpn" ||
    lang === "zh" ||
    lang === "zho" ||
    lang === "chi" ||
    lang === "ko" ||
    lang === "kor" ||
    countries.some((c) => ["JP", "CN", "KR", "TW"].includes(c)) ||
    /japan|china|korea|taiwan/i.test(metaCountry)
  );
}

function settled(id: string): boolean {
  return detected.has(id) || negatives.has(id) || checked.has(id);
}

async function checkOne(it: DetectItem): Promise<void> {
  const id = it._id;
  try {
    checked.add(id);
    const tmdb = /^tmdb:tv:(\d+)$/.exec(id);
    let anime = false;
    let hasMeta = false;
    if (tmdb) {
      // Cinemeta only resolves IMDb ids; a TMDB row is anime exactly when its
      // TV id maps to a Kitsu entry.
      anime = (await tmdbTvToKitsu(Number(tmdb[1])).catch(() => null)) != null;
    } else {
      const m = (await fetchMeta(it.type === "movie" ? "movie" : "series", id)) as {
        genres?: string[];
        country?: string;
      } | null;
      hasMeta = !!m;
      anime = !!m && isJapaneseAnime(m);
      const originUnknown = !m || !primaryCountry(m);
      // Donghua and other mapped animation can have a known non-Japanese origin.
      // Require an exact anime mapping rather than treating all animation as anime.
      const needsMapping =
        !m || hasAnimationGenre(m) || (originUnknown && (m.genres ?? []).length === 0);
      if (!anime && needsMapping) {
        anime = (await imdbToKitsu(id).catch(() => null)) != null;
      }
    }
    if (anime) {
      detected.add(id);
      persist();
      bump();
    } else if (hasMeta) {
      negatives.add(id);
      persistNegatives();
    }
  } catch {
  } finally {
    pending.delete(id);
  }
}

function runOne(it: DetectItem): Promise<void> {
  const p = checkOne(it).finally(() => {
    inflight.delete(it._id);
  });
  inflight.set(it._id, p);
  return p;
}

async function runPool(items: DetectItem[]): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = items[next++];
      if (!it) return;
      await runOne(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
}

let draining = false;

async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      await runPool(queue.splice(0, EAGER_BUDGET));
    }
  } finally {
    draining = false;
  }
}

function scheduleDrain(): void {
  if (draining || queue.length === 0) return;
  draining = true;
  setTimeout(() => {
    void drain();
  }, DEFER_MS);
}

export async function detectAnimeForCw(items: Array<{ _id: string; type: string }>): Promise<void> {
  const urgent = items.length <= CONCURRENCY;
  const eligible: DetectItem[] = [];
  const waits: Array<Promise<void>> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const id = it._id;
    if (!/^tt\d+$/.test(id) && !/^tmdb:tv:\d+$/.test(id)) continue;
    if (seen.has(id) || settled(id)) continue;
    seen.add(id);
    const running = inflight.get(id);
    if (running) {
      if (urgent) waits.push(running);
      continue;
    }
    const queuedAt = urgent ? queue.findIndex((q) => q._id === id) : -1;
    if (queuedAt >= 0) {
      eligible.push(...queue.splice(queuedAt, 1));
      continue;
    }
    if (pending.has(id)) continue;
    pending.add(id);
    eligible.push({ _id: id, type: it.type });
  }
  if (eligible.length === 0 && waits.length === 0) return;
  for (const it of eligible.slice(EAGER_BUDGET)) queue.push(it);
  scheduleDrain();
  await Promise.all([runPool(eligible.slice(0, EAGER_BUDGET)), ...waits]);
}

/**
 * CW-only alias reconciliation: TMDB -> IMDb external IDs are authoritative,
 * whereas a matching title or an episode number is not evidence of identity.
 * Run only for watched CW members, never the whole media catalog.
 */
const cwAliasLookups = new Map<string, { imdb: string | null; expiresAt: number }>();
const cwAliasInflight = new Map<string, Promise<void>>();
const CW_ALIAS_POSITIVE_TTL = 24 * 60 * 60 * 1000;
const CW_ALIAS_NEGATIVE_TTL = 60 * 1000;

async function warmCwAnimeAlias(tmdbId: string, tmdbKey: string): Promise<void> {
  // Only the persisted positive mark can skip promotion. A positive answer via
  // the IMDb cache still needs to be saved under this TMDB ID for later runs.
  if (detected.has(tmdbId)) return;
  // API keys are never persisted in cache identities.
  const cacheKey = tmdbId + "|" + (tmdbKey ? "tmdb" : "public");
  const existing = cwAliasInflight.get(cacheKey);
  if (existing) return existing;
  const task = (async () => {
    let imdb: string | null = null;
    const saved = cwAliasLookups.get(cacheKey);
    if (saved && saved.expiresAt > Date.now()) {
      imdb = saved.imdb;
    } else {
      const fromTmdb = tmdbImdbCached(tmdbId);
      if (typeof fromTmdb === "string") imdb = fromTmdb;
      if (!imdb && tmdbKey) {
        imdb = await tmdbImdbId(tmdbKey, tmdbId).catch(() => null);
      }
      if (!imdb) {
        const { getImdbForTmdb } = await import("@/lib/publicmetadb/mappings");
        const id = Number(tmdbId.slice("tmdb:tv:".length));
        imdb = await getImdbForTmdb(id, "tv").catch(() => null);
      }
      if (!imdb || !/^tt[1-9]\d*$/.test(imdb)) imdb = null;
      cwAliasLookups.set(cacheKey, {
        imdb,
        expiresAt: Date.now() + (imdb ? CW_ALIAS_POSITIVE_TTL : CW_ALIAS_NEGATIVE_TTL),
      });
    }
    if (!imdb) return;
    if (!detected.has(imdb)) {
      // The linked IMDb record must independently pass the existing strict
      // anime detector; merely having an external ID is insufficient.
      await detectAnimeForCw([{ _id: imdb, type: "series" }]);
    }
    if (!detected.has(imdb) || detected.has(tmdbId)) return;
    detected.add(tmdbId);
    if (negatives.delete(tmdbId)) persistNegatives();
    persist();
    bump();
  })().catch(() => {}).finally(() => cwAliasInflight.delete(cacheKey));
  cwAliasInflight.set(cacheKey, task);
  return task;
}

export async function warmCwAnimeRoomAliases(
  items: Array<{ _id: string; type: string }>,
  tmdbKey = "",
): Promise<void> {
  const ids = [...new Set(
    items
      .filter((i) => i.type !== "movie" && /^tmdb:tv:[1-9]\d*$/.test(i._id))
      .map((i) => i._id),
  )].filter((id) => !detected.has(id));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) await warmCwAnimeAlias(id, tmdbKey);
      }
    }),
  );
}
