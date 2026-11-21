import { getCachedCatalogImdb, provenCwAnimeIdentity } from "@/lib/cw-anime-identity";
import { resolveCwAnimeVideo } from "@/lib/cw-anime-video";
import type { RepairableCwRow, CatalogCwEvidence } from "./cw-repair";

/**
 * Reuse CW's checkpoint-scoped catalog proof rather than guessing a cour from
 * the catalog's season number. That proof is issued only after finding an
 * exact Kitsu addon episode matching the external IMDb ID and provider S/E.
 */
export type CatalogEvidenceDeps = {
  proven: (row: RepairableCwRow) => string | null;
  getImdb: (catalogId: string) => string | null;
  video: (
    row: RepairableCwRow,
    coords: { season: number; episode: number },
  ) => Promise<{ id: string; imdb_id?: string; imdbSeason?: number; imdbEpisode?: number } | null>;
};

const DEFAULT: CatalogEvidenceDeps = {
  proven: provenCwAnimeIdentity,
  getImdb: getCachedCatalogImdb,
  video: (row, coords) =>
    resolveCwAnimeVideo(row as Parameters<typeof resolveCwAnimeVideo>[0], coords),
};

export async function catalogCwEvidence(
  row: RepairableCwRow,
  deps: CatalogEvidenceDeps = DEFAULT,
): Promise<CatalogCwEvidence | null> {
  if (row.type !== "series" || !/^(?:tt[1-9]\d*|tmdb:tv:[1-9]\d*)$/.test(row._id))
    return null;
  const season = row.state?.season;
  const episode = row.state?.episode;
  if (!Number.isInteger(season) || !Number.isInteger(episode) ||
      !season || season < 1 || !episode || episode < 1)
    return null;

  const target = deps.proven(row);
  if (!target || !/^kitsu:[1-9]\d*$/.test(target)) return null;

  const imdbId = /^tt[1-9]\d*$/.test(row._id)
    ? row._id
    : row.altIds?.find((id) => /^tt[1-9]\d*$/.test(id)) ?? deps.getImdb(row._id);
  if (!imdbId) return null;

  // Independent confirmation: the actual Kitsu video has the same IMDb
  // catalog identity and exact provider episode coordinates.
  const video = await deps.video(row, { season, episode }).catch(() => null);
  const stream = /^kitsu:([1-9]\d*):([1-9]\d*)$/.exec(video?.id ?? "");
  if (!stream || target !== `kitsu:${stream[1]}` ||
      video?.imdb_id !== imdbId ||
      video.imdbSeason !== season || video.imdbEpisode !== episode)
    return null;
  return { target, nativeEpisode: Number(stream[2]) };
}
