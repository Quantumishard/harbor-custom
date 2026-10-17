import { useEffect, useMemo, useState } from "react";
import { harborImdbEpisodes, harborImdbEpisodesCached } from "@/lib/providers/harbor-imdb";
import { omdbSeasonRatings, omdbSeasonRatingsCached } from "@/lib/providers/omdb";

function cachedRatings(imdbId: string | null, seasons: readonly number[]): Map<string, number> {
  const ratings = new Map<string, number>();
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return ratings;
  for (const [coordinate, rating] of harborImdbEpisodesCached(imdbId) ?? [])
    if (Number.isFinite(rating) && rating > 0 && rating <= 10) ratings.set(coordinate, rating);
  for (const season of seasons)
    for (const [episode, rating] of omdbSeasonRatingsCached(imdbId, season) ?? [])
      if (Number.isFinite(rating) && rating > 0 && rating <= 10)
        ratings.set(`${season}:${episode}`, rating);
  return ratings;
}

export function useEpisodeImdbRatings(
  imdbId: string | null,
  season: number | readonly number[],
  omdbKey: string,
) {
  const seasonKey = JSON.stringify(
    [
      ...new Set(
        (typeof season === "number" ? [season] : season).filter(
          (value) => Number.isInteger(value) && value >= 1,
        ),
      ),
    ].sort((a, b) => a - b),
  );
  const seasons = useMemo<number[]>(() => JSON.parse(seasonKey), [seasonKey]);
  const key = JSON.stringify([imdbId, seasonKey, omdbKey]);
  const cached = useMemo(() => cachedRatings(imdbId, seasons), [imdbId, seasons]);
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
      const omdb = (async () => {
        const combined = new Map<string, number>();
        if (!omdbKey) return combined;
        let next = 0;
        const worker = async () => {
          while (!cancelled && next < seasons.length) {
            const selectedSeason = seasons[next++];
            const ratings = await omdbSeasonRatings(omdbKey, imdbId, selectedSeason).catch(
              () => new Map<number, number>(),
            );
            if (cancelled) return;
            const coordinates = new Map(
              [...ratings].map(([episode, rating]) => [`${selectedSeason}:${episode}`, rating]),
            );
            publish(coordinates);
            for (const [coordinate, rating] of coordinates) combined.set(coordinate, rating);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, seasons.length) }, worker));
        return combined;
      })();
      void Promise.all([harbor, omdb]).then((sources) => {
        loading = false;
        const hasSeason = (ratings: Map<string, number>, selectedSeason: number) =>
          [...ratings].some(
            ([coordinate, rating]) =>
              coordinate.startsWith(`${selectedSeason}:`) &&
              Number.isFinite(rating) &&
              rating > 0 &&
              rating <= 10,
          );
        const missingSeason = seasons.some(
          (selectedSeason) =>
            !hasSeason(cached, selectedSeason) &&
            !sources.some((ratings) => hasSeason(ratings, selectedSeason)),
        );
        if (!cancelled && missingSeason && attempts < 3) retry = setTimeout(refresh, 60_000);
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
  }, [key, imdbId, seasons, omdbKey, cached]);
  return useMemo(() => (result.key === key ? result.ratings : cached), [result, key, cached]);
}
