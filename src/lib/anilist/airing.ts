import type { CalendarItem } from "@/lib/calendar";
import { toLocalDateISO, toLocalTimeLabel } from "@/lib/calendar-time";
import { anilistRequest, AnilistApiError } from "./client";

const AIRING_QUERY = `query ($start: Int, $end: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      airingAt
      episode
      media {
        id
        idMal
        type
        isAdult
        format
        title { romaji english }
        coverImage { extraLarge large }
        bannerImage
        averageScore
        description
      }
    }
    pageInfo {
      hasNextPage
    }
  }
}`;

type AiringMedia = {
  id: number;
  idMal: number | null;
  type: string | null;
  isAdult: boolean | null;
  format: string | null;
  title: { romaji: string | null; english: string | null } | null;
  coverImage: { extraLarge: string | null; large: string | null } | null;
  bannerImage: string | null;
  averageScore: number | null;
  description: string | null;
};

type AiringNode = {
  airingAt: number;
  episode: number | null;
  media: AiringMedia | null;
};

type AiringResponse = {
  Page: {
    airingSchedules: AiringNode[] | null;
    pageInfo: { hasNextPage: boolean } | null;
  } | null;
};

// A busy month can contain more than 500 scheduled episodes. Keep paginating,
// but bound the work in case AniList returns a broken cursor.
const MAX_PAGES = 30;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchAniListAiringCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const start = Math.floor(new Date(year, month, 1).getTime() / 1000);
  const end = Math.floor(new Date(year, month + 1, 1).getTime() / 1000);

  const out: CalendarItem[] = [];
  const seen = new Set<string>();
  // A connected AniList account gets its own request quota. If its token has
  // expired, switch to anonymous requests for the rest of this calendar load.
  let anonymous = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: AiringResponse;
    try {
      data = await anilistRequest<AiringResponse>(
        AIRING_QUERY,
        { start, end, page },
        undefined,
        anonymous,
      );
    } catch (error) {
      if (!anonymous && error instanceof AnilistApiError && error.isAuthenticationError) {
        anonymous = true;
        data = await anilistRequest<AiringResponse>(
          AIRING_QUERY,
          { start, end, page },
          undefined,
          true,
        );
      } else if (error instanceof AnilistApiError && error.status === 429) {
        throw new Error("AniList is rate-limiting calendar requests. Please try again shortly.", {
          cause: error,
        });
      } else {
        throw error;
      }
    }
    const nodes = data.Page?.airingSchedules;
    if (!nodes) throw new Error("AniList returned an incomplete airing schedule.");
    for (const node of nodes) {
      const media = node.media;
      if (!media) continue;
      if (media.type !== "ANIME" || media.isAdult) continue;
      if (media.format === "MOVIE" || node.episode == null) continue;
      const title = media.title?.english?.trim() || media.title?.romaji?.trim() || "Untitled";
      const baseId = media.idMal != null ? `mal:${media.idMal}` : `anilist:${media.id}`;
      const id = `${baseId}:1:${node.episode}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const airMs = node.airingAt * 1000;
      out.push({
        id,
        imdbId: null,
        type: "tv",
        name: `${title.replace(/\bSeason\s+(\d+)/i, "S$1")} E${pad(node.episode)}`,
        poster: media.coverImage?.large ?? media.coverImage?.extraLarge ?? null,
        background: media.bannerImage ?? null,
        releaseDate: toLocalDateISO(new Date(airMs)),
        releaseTime: toLocalTimeLabel(new Date(airMs)),
        releaseAtMs: airMs,
        isAnime: true,
        overview: media.description ? stripHtml(media.description) : "",
        voteAverage: media.averageScore != null ? media.averageScore / 10 : 0,
      });
    }
    if (!(data.Page?.pageInfo?.hasNextPage ?? nodes.length >= 50)) break;
    if (page === MAX_PAGES) {
      throw new Error("AniList returned more airing episodes than the calendar can load.");
    }
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}
