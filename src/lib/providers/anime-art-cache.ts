import { registerEvictable } from "@/lib/maintenance";
import { registerCache } from "@/lib/memory-profiler";
import { reusableAnimeBackdrop } from "./anime-art-quality";
import type { AnimeArtworkKind } from "./anime-format";

export type AnimeArt = { bg?: string; logo?: string; backdrops?: string[] };
type Entry = AnimeArt & { t: number; kind?: AnimeArtworkKind; backdropVersion?: number };

const KEY = "harbor.anime.art.v2";
const MOVIE_BACKDROP_VERSION = 1;
const CAP = 1000;
const TTL = 60 * 24 * 60 * 60 * 1000;
const RESTAMP_MS = 24 * 60 * 60 * 1000;
const mem = new Map<string, Entry>();
let loaded = false;
// Set when the last write failed, so the next save writes again even when its art is unchanged.
let unsaved = false;

registerCache("anime:art", () => mem.size);
registerEvictable("anime-art", (aggressive) => {
  if (aggressive) {
    mem.clear();
    loaded = false;
  }
});

function ensure(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as { map?: Record<string, Entry> };
    const now = Date.now();
    for (const [k, e] of Object.entries(raw.map ?? {})) {
      // Older builds stored the 1900x400 AniList banner as hero art; drop it on read so the
      // surfaces that resolve their own artwork can replace it.
      if (!e || now - e.t >= TTL) continue;
      const needsMovieBackdrop = e.kind === "movie" && e.backdropVersion !== MOVIE_BACKDROP_VERSION;
      mem.set(k, { ...e, bg: needsMovieBackdrop ? undefined : reusableAnimeBackdrop(e.bg) });
    }
  } catch {
    /* ignore */
  }
}

function persist(): void {
  const entries = [...mem.entries()];
  const trimmed =
    entries.length > CAP ? entries.sort((a, b) => b[1].t - a[1].t).slice(0, CAP) : entries;
  try {
    localStorage.setItem(KEY, JSON.stringify({ map: Object.fromEntries(trimmed) }));
    unsaved = false;
  } catch {
    unsaved = true;
  }
}

// Callers rebuild the backdrop array on every resolve, so an identity check
// treated unchanged art as new and rewrote the whole 1000-entry blob each time.
function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function entryFor(key: string, kind: AnimeArtworkKind): Entry | undefined {
  ensure();
  const entry = mem.get(key);
  // Legacy records lack provenance and may hold the parent series' art for a film.
  return (entry?.kind ?? "tv") === kind ? entry : undefined;
}

export function peekAnimeArt(
  key: string | undefined | null,
  kind: AnimeArtworkKind,
): AnimeArt | undefined {
  return key ? entryFor(key, kind) : undefined;
}

export function saveAnimeArt(
  key: string | undefined | null,
  kind: AnimeArtworkKind,
  art: AnimeArt,
): void {
  if (!key || (!art.bg && !art.logo && !art.backdrops?.length)) return;
  const prev = entryFor(key, kind);
  const next: Entry = {
    kind,
    backdropVersion: kind === "movie" ? MOVIE_BACKDROP_VERSION : undefined,
    bg: reusableAnimeBackdrop(art.bg) ?? reusableAnimeBackdrop(prev?.bg),
    logo: art.logo ?? prev?.logo,
    backdrops: art.backdrops?.length ? art.backdrops : prev?.backdrops,
    t: Date.now(),
  };
  // Unchanged art is still re-stamped once a day, so artwork in use keeps its
  // TTL on the next load without a write on every resolve.
  if (
    prev &&
    !unsaved &&
    next.t - prev.t < RESTAMP_MS &&
    next.backdropVersion === prev.backdropVersion &&
    next.bg === prev.bg &&
    next.logo === prev.logo &&
    sameList(next.backdrops, prev.backdrops)
  )
    return;
  mem.set(key, next);
  persist();
}
