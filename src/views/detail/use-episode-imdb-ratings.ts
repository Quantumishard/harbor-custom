import { useEffect, useMemo, useState } from "react";
import { harborImdbEpisodes, harborImdbEpisodesCached } from "@/lib/providers/harbor-imdb";
import { omdbSeasonRatings, omdbSeasonRatingsCached } from "@/lib/providers/omdb";

function cachedRatings(imdbId: string | null, season: number): Map<string, number> {
  const ratings = new Map<string, number>();
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return ratings;
  for (const [coordinate, rating] of harborImdbEpisodesCached(imdbId) ?? [])
    if (Number.isFinite(rating) && rating > 0 && rating <= 10) ratings.set(coordinate, rating);
  for (const [episode, rating] of omdbSeasonRatingsCached(imdbId, season) ?? [])
    if (Number.isFinite(rating) && rating > 0 && rating <= 10)
      ratings.set(`${season}:${episode}`, rating);
  return ratings;
}

export function useEpisodeImdbRatings(imdbId: string | null, season: number, omdbKey: string) {
  const key = JSON.stringify([imdbId, season, omdbKey]);
  const cached = useMemo(() => cachedRatings(imdbId, season), [imdbId, season]);
  const [result, setResult] = useState({ key, ratings: cached });
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let loading = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const publish = (ratings: Map<string, number>) => {
      if (cancelled || ratings.size === 0) return;
      setResult((previous) => {
        const merged = new Map(previous.key === key ? previous.ratings : cached);
        for (const [coordinate, rating] of ratings) {
          if (Number.isFinite(rating) && rating > 0 && rating <= 10) merged.set(coordinate, rating);
        }
        return { key, ratings: merged };
      });
    };
    const refresh = () => {
      if (cancelled || loading || !imdbId?.match(/^tt\d+$/)) return;
      if (retry !== undefined) clearTimeout(retry);
      loading = true;
      attempts++;
      // Independent requests: a retired Harbor server must not hold up OMDb.
      const harbor = harborImdbEpisodes(imdbId)
        .then((ratings) => {
          publish(ratings);
          return ratings;
        })
        .catch(() => new Map<string, number>());
      const omdb =
        omdbKey && season >= 1
          ? omdbSeasonRatings(omdbKey, imdbId, season)
              .then((ratings) => {
                const coordinates = new Map(
                  [...ratings].map(([episode, rating]) => [`${season}:${episode}`, rating]),
                );
                publish(coordinates);
                return coordinates;
              })
              .catch(() => new Map<string, number>())
          : Promise.resolve(new Map<string, number>());
      void Promise.all([harbor, omdb]).then((sources) => {
        loading = false;
        const hasRatings = sources.some((ratings) =>
          [...ratings].some(
            ([coordinate, rating]) =>
              coordinate.startsWith(`${season}:`) &&
              Number.isFinite(rating) &&
              rating > 0 &&
              rating <= 10,
          ),
        );
        if (
          !cancelled &&
          !hasRatings &&
          ![...cached.keys()].some((coordinate) => coordinate.startsWith(`${season}:`)) &&
          attempts < 3
        )
          retry = setTimeout(refresh, 60_000);
      });
    };
    refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("online", refresh);
      window.addEventListener("focus", refresh);
    }
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", refresh);
        window.removeEventListener("focus", refresh);
      }
    };
  }, [key, imdbId, season, omdbKey, cached]);
  return useMemo(() => (result.key === key ? result.ratings : cached), [result, key, cached]);
}
