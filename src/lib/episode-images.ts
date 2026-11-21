import type { Episode } from "./providers/tmdb";

export function episodeImageCandidates(
  ep: Pick<Episode, "stillPath" | "stillUrl">,
  thumbnail?: string,
  hd = false,
): string[] {
  const path = ep.stillPath;
  const tmdb = path
    ? /^https?:\/\//i.test(path)
      ? path
      : `https://image.tmdb.org/t/p/${hd ? "original" : "w300"}${path}`
    : undefined;
  return [...new Set([tmdb, ep.stillUrl, thumbnail].filter((url): url is string => !!url))];
}
