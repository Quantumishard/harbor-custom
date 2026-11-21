import { useEffect, useState } from "react";
import { meta as fetchMeta } from "@/lib/cinemeta";
import { createRequestScheduler } from "@/lib/request-scheduler";

type Kind = "movie" | "series";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();
const subs = new Map<string, Set<() => void>>();
const requests = createRequestScheduler({ concurrency: 3 });

export function cinemetaRatingCached(imdbId: string | undefined): string | undefined {
  if (!imdbId) return undefined;
  return cache.get(imdbId) ?? undefined;
}

export function cinemetaRatingPrefetch(imdbId: string, kind: Kind): void {
  if (!imdbId.startsWith("tt") || cache.has(imdbId) || inflight.has(imdbId)) return;
  const p = requests
    .schedule(imdbId, () => fetchMeta(kind, imdbId))
    .then((m) => {
      cache.set(imdbId, m?.imdbRating ?? null);
    })
    .catch(() => {
      cache.set(imdbId, null);
    })
    .finally(() => {
      inflight.delete(imdbId);
      for (const fn of subs.get(imdbId) ?? []) fn();
    });
  inflight.set(imdbId, p);
}

export function useCinemetaRating(imdbId: string | undefined): string | undefined {
  const [v, setV] = useState<string | undefined>(() => cinemetaRatingCached(imdbId));
  useEffect(() => {
    setV(cinemetaRatingCached(imdbId));
    if (!imdbId) return;
    const fn = () => setV(cinemetaRatingCached(imdbId));
    const listeners = subs.get(imdbId) ?? new Set<() => void>();
    listeners.add(fn);
    subs.set(imdbId, listeners);
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0) subs.delete(imdbId);
    };
  }, [imdbId]);
  return v;
}
