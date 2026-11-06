import { useMemo } from "react";
import type { Meta } from "./cinemeta";
import type { TmdbDetail } from "./providers/tmdb/tmdb-details";
import { useTraktRelated } from "./providers/trakt-related";

const EMPTY: Meta[] = [];

export function useMoreLikeThis(meta: Meta, detail: TmdbDetail | null, enabled = true): Meta[] {
  const imdb = /^tt\d+$/.test(meta.id) ? meta.id : null;
  const tmdb = meta.id.match(/^tmdb:(?:(movie|tv):)?(\d+)$/);
  const current =
    enabled &&
    detail &&
    ((imdb && detail.imdbId !== imdb) ||
      (tmdb &&
        (String(detail.id) !== tmdb[2] ||
          detail.kind !== (tmdb[1] ?? (meta.type === "series" ? "tv" : "movie")))))
      ? null
      : detail;
  const seed = enabled ? (imdb ?? current?.imdbId ?? null) : null;
  const related = useTraktRelated(seed, meta.type === "series" ? "show" : "movie");
  const fallback = current?.recommendations ?? EMPTY;
  return useMemo(() => {
    if (!enabled) return fallback;
    const seen = new Set([meta.id, seed, current ? `tmdb:${current.kind}:${current.id}` : null]);
    return (related.length > 0 ? related : fallback).filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [enabled, related, fallback, meta.id, seed, current?.kind, current?.id]);
}
