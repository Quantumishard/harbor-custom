import { invoke } from "@tauri-apps/api/core";
import type { MusicTrack } from "./types";

const TTL = 10 * 60_000;
const cache = new Map<string, { expires: number; tracks: MusicTrack[] }>();
const pending = new Map<string, Promise<MusicTrack[]>>();

const VIDEO_RESULT_CAP = 12;

const NOISE =
  /\b(official|video|audio|music|lyric|lyrics|visualizer|hd|hq|4k|8k|explicit|clean|edit|version|mv|m\/v|prod|dir)\b/g;

/**
 * Re-uploads of one song differ only by marketing words, so they collapse to a single
 * entry. Remix, live, instrumental and karaoke name a different recording and stay apart.
 */
export function musicVideoIdentity(title: string, artist: string): string {
  const strip = (value: string) =>
    value
      .toLowerCase()
      .replace(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]*[\)\]]/gi, " ")
      .replace(/\b(?:feat\.?|ft\.?|featuring)\b[^-]*/g, " ")
      .replace(NOISE, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${strip(title)}|${strip(artist)}`;
}

const VERSION_MARKER =
  /\b(remix|remixes|live|acoustic|instrumental|karaoke|cover|sped|slowed|reverb|nightcore|mashup|bootleg|extended|demo|rehearsal|8d|performance)\b/i;

const OFFICIAL_VIDEO = /\bofficial\b[\s\S]*\b(?:mv|video)\b/i;

/**
 * The provider ranks by words, not by recording, so the official video can sit under
 * remixes and lyric uploads. Prefer titles that match the query and carry no version marker.
 */
export function rankMusicVideos(tracks: MusicTrack[], query: string): MusicTrack[] {
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter(Boolean),
    );
  // Act names recur in every upload title, so rank on the words that identify the song.
  const artistWords = new Set<string>();
  for (const track of tracks) for (const word of words(track.artist)) artistWords.add(word);
  const queryWords = [...words(query)];
  const songWords = queryWords.filter((word) => !artistWords.has(word));
  const wanted = songWords.length > 0 ? songWords : queryWords;
  const foldedQuery = folded(query);
  const score = (track: MusicTrack): number => {
    const title = words(track.title);
    let overlap = 0;
    for (const word of wanted) if (title.has(word)) overlap += 1;
    // "Gnarly" the song beats "KATSEYE - Gnarly (Clean ver.) #엠카운트다운", which only
    // contains the word.
    const exact = folded(track.title) === foldedQuery ? 3 : 0;
    const official = OFFICIAL_VIDEO.test(track.title) ? 2 : 0;
    return overlap * 10 + exact + official + (VERSION_MARKER.test(track.title) ? 0 : 1);
  };
  return [...tracks].sort((left, right) => score(right) - score(left));
}

/** Collapsed to letters and digits so a name is matched whole, never token by token. */
function relevanceKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * A search for one act happily returns another whose name merely shares words, so a result has
 * to carry the requested name whole, in its artist or its title. The title counts because a
 * re-upload or edit is credited to the uploader while still naming the act.
 */
function aboutSubject(track: MusicTrack, subject: string): boolean {
  const want = relevanceKey(subject);
  if (want.length < 3) return true;
  return relevanceKey(track.artist).includes(want) || relevanceKey(track.title).includes(want);
}

const canonicalTitles = new Map<string, string>();

const folded = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * A bare song name is ambiguous to the provider and can come back as stage clips, covers
 * and other songs. When the query is the song that is playing, its artist anchors it.
 */
export function anchoredVideoQuery(query: string, track: MusicTrack | null): string {
  if (!track || !track.artist.trim()) return query;
  const words = folded(query);
  if (!words || words !== folded(track.title)) return query;
  return `${track.artist} ${query}`.trim();
}
/**
 * YouTube Music mislabels some official videos (the one it calls "Smart (Slowed + Reverb
 * ver.)" is titled "OFFICIAL MV" on youtube.com), so titles are corrected from YouTube's
 * own metadata before the list is shown or ranked.
 */
export async function correctVideoTitles(tracks: MusicTrack[]): Promise<MusicTrack[]> {
  const missing = [
    ...new Set(
      tracks
        .map((track) => track.sourceId)
        .filter(
          (id): id is string =>
            typeof id === "string" && /^[\w-]{11}$/.test(id) && !canonicalTitles.has(id),
        ),
    ),
  ].slice(0, 24);
  if (missing.length > 0) {
    try {
      const found = await invoke<Record<string, unknown>>("music_video_titles", { ids: missing });
      for (const [id, title] of Object.entries(found ?? {})) {
        if (typeof title === "string" && title.trim()) canonicalTitles.set(id, title.trim());
      }
    } catch {
      // A metadata lookup failure must not hide the provider's own results.
    }
    while (canonicalTitles.size > 400) canonicalTitles.delete(canonicalTitles.keys().next().value!);
  }
  return tracks.map((track) => {
    const title = track.sourceId ? canonicalTitles.get(track.sourceId) : undefined;
    return title && title !== track.title ? { ...track, title } : track;
  });
}

/** Only accepts exact YouTube identities returned by the native video-only endpoint. */
export function musicVideoResults(
  value: unknown,
  cap = VIDEO_RESULT_CAP,
  subject = "",
): MusicTrack[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const songs = new Set<string>();
  return value
    .filter((track): track is MusicTrack => {
      if (
        !track ||
        typeof track !== "object" ||
        track.connectorId !== "youtube" ||
        typeof track.sourceId !== "string" ||
        !/^[\w-]{11}$/.test(track.sourceId) ||
        typeof track.id !== "string" ||
        typeof track.title !== "string" ||
        !track.title.trim() ||
        typeof track.artist !== "string" ||
        typeof track.artwork !== "string" ||
        typeof track.durationSeconds !== "number" ||
        typeof track.durationLabel !== "string" ||
        seen.has(track.sourceId)
      )
        return false;
      if (subject && !aboutSubject(track, subject)) return false;
      const identity = musicVideoIdentity(track.title, track.artist);
      if (identity.length > 1 && songs.has(identity)) return false;
      seen.add(track.sourceId);
      songs.add(identity);
      return true;
    })
    .slice(0, cap)
    .map((track) => ({ ...track, mediaKind: "video", videoSearch: false }));
}

export type MusicVideoKind = "videos" | "concerts" | "interviews";

export const MUSIC_VIDEO_KIND_LABELS: Record<MusicVideoKind, string> = {
  videos: "music.videos.title",
  concerts: "music.videos.concerts",
  interviews: "music.videos.interviews",
};

export function musicVideoQuery(kind: MusicVideoKind, subject: string): string {
  const name = subject.trim();
  if (!name)
    return kind === "concerts"
      ? "full concert"
      : kind === "interviews"
        ? "music interview"
        : "music videos";
  if (kind === "concerts") return `${name} full concert`;
  if (kind === "interviews") return `${name} interview`;
  return `${name} music videos`;
}

export function musicVideoUsesYoutube(kind: MusicVideoKind): boolean {
  return kind === "concerts" || kind === "interviews";
}

const VIDEO_SEARCH_LIMIT = 40;

export const MUSIC_VIDEO_MAX = VIDEO_SEARCH_LIMIT;

export function searchMusicVideos(
  query: string,
  refresh = false,
  interviews = false,
  limit = VIDEO_RESULT_CAP,
  subject = "",
): Promise<MusicTrack[]> {
  const clean = query.trim().slice(0, 200);
  if (!clean) return Promise.resolve([]);
  const take = Math.max(1, Math.min(Math.trunc(limit) || VIDEO_RESULT_CAP, VIDEO_SEARCH_LIMIT));
  const key = `${interviews ? "interviews" : "videos"}:${subject.toLocaleLowerCase()}:${clean.toLocaleLowerCase()}`;
  const hit = cache.get(key);
  // Reinsert on a hit, because eviction takes the oldest entry and the list being watched is
  // read over and over without ever being written again.
  if (!refresh && hit && hit.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit.tracks.slice(0, take));
  }
  const request = pending.get(key);
  if (request) return request.then((tracks) => tracks.slice(0, take));
  const next: Promise<MusicTrack[]> = invoke<unknown>("music_search_videos", {
    query: clean,
    limit: VIDEO_SEARCH_LIMIT,
    interviews,
  })
    .then(async (value) => {
      const tracks = rankMusicVideos(
        await correctVideoTitles(musicVideoResults(value, VIDEO_SEARCH_LIMIT, subject)),
        clean,
      );
      cache.delete(key);
      cache.set(key, { expires: Date.now() + TTL, tracks });
      while (cache.size > 12) cache.delete(cache.keys().next().value!);
      return tracks;
    })
    .finally(() => {
      // A refresh started while this one was still running owns the slot now: clearing it
      // blindly would send the next caller to the native search a third time.
      if (pending.get(key) === next) pending.delete(key);
    });
  pending.set(key, next);
  return next.then((tracks) => tracks.slice(0, take));
}
