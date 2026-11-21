import { useMemo } from "react";
import {
  getEpisodeProgress,
  createEpisodeProgressSnapshot,
  type EpisodeProgress,
} from "@/lib/episode-progress";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import { spoilerMaskFor, type SpoilerMask } from "@/lib/spoilers";
import { airedOnly } from "../helpers";
import { animeSeasonKey } from "./anime-season-key";

const NO_PROGRESS: EpisodeProgress = { ratio: 0, watched: false, startedAt: 0 };

export function useAnimeProgressMap({
  episodes,
  displayEpisodes,
  metaId,
  trackId,
  traktWatched,
  anilistWatched,
  malWatched,
  pmdbWatched,
  entrySourceId,
  entryAnilistWatched,
  entryMalWatched,
  mwVersion,
  settings,
}: {
  episodes: KitsuEpisode[];
  displayEpisodes: KitsuEpisode[];
  metaId: string;
  trackId?: string;
  traktWatched: Set<string>;
  anilistWatched?: Set<string>;
  malWatched?: Set<string>;
  pmdbWatched?: Set<string>;
  entrySourceId?: string | null;
  entryAnilistWatched?: Set<string>;
  entryMalWatched?: Set<string>;
  mwVersion: number;
  settings: Parameters<typeof spoilerMaskFor>[0];
}) {
  const sourceById = useMemo(() => {
    const byId = new Map<number, KitsuEpisode>();
    for (const ep of episodes) {
      if (!byId.has(ep.id)) byId.set(ep.id, ep);
    }
    return byId;
  }, [episodes]);
  const progressFor = useMemo(() => {
    const local = createEpisodeProgressSnapshot();
    const progressById = new Map<number, EpisodeProgress>();
    const displayById = new Map<number, KitsuEpisode>();
    for (const ep of displayEpisodes) {
      if (!displayById.has(ep.id)) displayById.set(ep.id, ep);
    }
    return (episode: KitsuEpisode): EpisodeProgress => {
      const cached = progressById.get(episode.id);
      if (cached) return cached;
      // Prefer the source row's coordinates when a season view reuses its episode ID.
      const ep = sourceById.get(episode.id) ?? displayById.get(episode.id);
      if (!ep) return NO_PROGRESS;
      const isCurrent = ep.sourceMetaId == null;
      const isEntry = entrySourceId != null && ep.sourceMetaId === entrySourceId;
      const seasonKey = animeSeasonKey(ep);
      let prog = getEpisodeProgress(
        ep.sourceMetaId ?? metaId,
        seasonKey,
        ep.number,
        ep.length ?? null,
        ep.imdbId ?? null,
        traktWatched,
        undefined,
        isCurrent ? anilistWatched : isEntry ? entryAnilistWatched : undefined,
        undefined,
        isCurrent ? malWatched : isEntry ? entryMalWatched : undefined,
        ep.imdbSeason,
        ep.imdbEpisode,
        pmdbWatched,
        ep.absoluteNumber,
        local,
      );
      if (
        isCurrent &&
        !prog.watched &&
        trackId &&
        trackId !== metaId &&
        local.manualWatchedState(metaId, seasonKey, ep.number) !== false
      ) {
        const alt = getEpisodeProgress(
          trackId,
          seasonKey,
          ep.number,
          ep.length ?? null,
          ep.imdbId ?? null,
          traktWatched,
          undefined,
          anilistWatched,
          undefined,
          malWatched,
          ep.imdbSeason,
          ep.imdbEpisode,
          pmdbWatched,
          ep.absoluteNumber,
          local,
        );
        if (alt.watched || alt.ratio > prog.ratio) prog = alt;
      }
      progressById.set(ep.id, prog);
      return prog;
    };
  }, [
    sourceById,
    displayEpisodes,
    metaId,
    trackId,
    traktWatched,
    anilistWatched,
    malWatched,
    pmdbWatched,
    entrySourceId,
    entryAnilistWatched,
    entryMalWatched,
    mwVersion,
  ]);

  const nextUpEp = useMemo(() => {
    const scan = displayEpisodes.length > 0 ? displayEpisodes : episodes;
    for (const ep of scan) {
      if (!progressFor(ep).watched) return ep;
    }
    return null;
  }, [displayEpisodes, episodes, progressFor]);

  const nextUpId = nextUpEp ? nextUpEp.id : null;
  const nextUpNum = nextUpEp ? nextUpEp.number : null;

  const spoilerFor = (ep: KitsuEpisode): SpoilerMask =>
    spoilerMaskFor(settings, {
      watched: progressFor(ep).watched,
      isNextUp: ep.id === nextUpId,
    });

  const allWatched = useMemo(() => {
    const aired = airedOnly(displayEpisodes, (ep) => ep.airdate);
    return aired.length > 0 && aired.every((ep) => progressFor(ep).watched);
  }, [displayEpisodes, progressFor]);

  return { progressFor, nextUpNum, nextUpId, spoilerFor, allWatched };
}
