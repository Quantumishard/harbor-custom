import { anilistRequest } from "./client";
import { loadMedia } from "@/lib/media-cache";

export type AnilistNextAiring = { episode: number; airingAt: number };

const QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    nextAiringEpisode { episode airingAt }
  }
}`;

const NEXT_AIRING_TTL = 15 * 60_000;

/**
 * The next scheduled episode for an AniList entry.
 *
 * CW timers used to trust the episode list's air dates. For currently airing
 * anime those come from the Kitsu add-on and can be a week behind AniList (the
 * same schedule the detail page shows), which made timer-mode cards count down
 * to the wrong week. AniList is the authority when its next episode matches the
 * card's target.
 */
export async function fetchAnilistNextAiring(
  anilistId: number,
  maxAge?: number,
): Promise<AnilistNextAiring | null> {
  if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null;
  const result = await loadMedia<AnilistNextAiring>(
    "anilist-next-airing",
    [anilistId],
    async () => {
      const data = await anilistRequest<{
        Media: {
          id: number;
          nextAiringEpisode: { episode: number; airingAt: number } | null;
        } | null;
      }>(QUERY, { id: anilistId }, undefined, true);
      const media = data.Media;
      if (!media || media.id !== anilistId) return null;
      const next = media.nextAiringEpisode;
      if (
        !next ||
        !Number.isInteger(next.episode) ||
        next.episode <= 0 ||
        !Number.isFinite(next.airingAt) ||
        next.airingAt <= 0
      )
        return null;
      return { episode: next.episode, airingAt: next.airingAt };
    },
    { ttl: NEXT_AIRING_TTL, maxAge },
  );
  return result.value;
}

export type AnilistAiringSchedule = Record<number, number>;

const SCHEDULE_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    airingSchedule(perPage: 50) {
      nodes { episode airingAt }
    }
  }
}`;

/** All known airing dates for an entry, keyed by AniList episode number. */
export async function fetchAnilistAiringSchedule(
  anilistId: number,
  maxAge?: number,
): Promise<AnilistAiringSchedule | null> {
  if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null;
  const result = await loadMedia<AnilistAiringSchedule>(
    "anilist-airing-schedule",
    [anilistId],
    async () => {
      const data = await anilistRequest<{
        Media: {
          id: number;
          airingSchedule: { nodes: Array<{ episode: number; airingAt: number }> };
        } | null;
      }>(SCHEDULE_QUERY, { id: anilistId }, undefined, true);
      const media = data.Media;
      if (!media || media.id !== anilistId) return null;
      const schedule: AnilistAiringSchedule = {};
      for (const node of media.airingSchedule?.nodes ?? []) {
        if (
          !Number.isInteger(node.episode) ||
          node.episode <= 0 ||
          !Number.isFinite(node.airingAt) ||
          node.airingAt <= 0
        )
          continue;
        schedule[node.episode] = node.airingAt;
      }
      return Object.keys(schedule).length > 0 ? schedule : null;
    },
    { ttl: NEXT_AIRING_TTL, maxAge },
  );
  return result.value;
}

/**
 * Replace provider episode dates with the AniList schedule. Only single-season
 * lists are safe: episode numbers are entry-relative, so a multi-season list
 * could map one number to different entries.
 */
export function applyAiringSchedule<
  T extends { season: number; episode: number; airDate?: string },
>(episodes: T[], schedule: AnilistAiringSchedule | null): void {
  if (!schedule) return;
  const seasons = new Set(
    episodes
      .filter((episode) => Number.isInteger(episode.season) && episode.season > 0)
      .map((episode) => episode.season),
  );
  if (seasons.size > 1) return;
  for (const episode of episodes) {
    // Season-zero specials can share episode numbers with the regular cour,
    // but must never inherit that cour's release date.
    if (!Number.isInteger(episode.season) || episode.season <= 0) continue;
    const airingAt = schedule[episode.episode];
    if (Number.isFinite(airingAt) && airingAt > 0) {
      episode.airDate = new Date(airingAt * 1000).toISOString();
    }
  }
}
