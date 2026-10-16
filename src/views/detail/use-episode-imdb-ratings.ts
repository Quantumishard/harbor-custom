import { useEffect, useMemo, useState } from "react";
import { harborImdbEpisodes } from "@/lib/providers/harbor-imdb";
import { omdbSeasonRatings } from "@/lib/providers/omdb";

export function useEpisodeImdbRatings(imdbId: string | null, season: number, omdbKey: string) {
  const key = JSON.stringify([imdbId, season, omdbKey]);
  const [result, setResult] = useState({ key: "", ratings: new Map<string, number>() });
  useEffect(() => {
    let cancelled = false;
    const publish = (ratings: Map<string, number>) => {
      if (cancelled || ratings.size === 0) return;
      setResult((previous) => {
        const merged = new Map(previous.key === key ? previous.ratings : []);
        for (const [coordinate, rating] of ratings) {
          if (Number.isFinite(rating) && rating > 0 && rating <= 10) merged.set(coordinate, rating);
        }
        return { key, ratings: merged };
      });
    };
    if (imdbId?.match(/^tt\d+$/)) {
      // Independent requests: a retired Harbor server must not hold up OMDb.
      void harborImdbEpisodes(imdbId)
        .then(publish)
        .catch(() => {});
      if (omdbKey && season >= 1) {
        void omdbSeasonRatings(omdbKey, imdbId, season)
          .then((ratings) =>
            publish(new Map([...ratings].map(([ep, rating]) => [`${season}:${ep}`, rating]))),
          )
          .catch(() => {});
      }
    }
    return () => {
      cancelled = true;
    };
  }, [key, imdbId, season, omdbKey]);
  return useMemo(
    () => (result.key === key ? result.ratings : new Map<string, number>()),
    [result, key],
  );
}
