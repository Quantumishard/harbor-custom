import { normalizeTitle } from "./search-normalize";
import type { MusicTrack } from "./types";

const tokens = (value: string): string[] => normalizeTitle(value).split(" ").filter(Boolean);

function covers(needle: string[], haystack: Set<string>): boolean {
  return needle.length > 0 && needle.every((token) => haystack.has(token));
}

/**
 * A picked video is the song already playing when a different upload carries the whole
 * title and the lead artist. "Smart" and "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV"
 * are the same recording; a remix, live take or another song is not.
 */
function sameRecording(current: MusicTrack, track: MusicTrack): boolean {
  if (current.id === track.id && (current.connectorId ?? "") === (track.connectorId ?? "")) {
    return true;
  }
  const video = new Set([...tokens(track.title), ...tokens(track.artist)]);
  const song = new Set([...tokens(current.title), ...tokens(current.artist)]);
  const title = tokens(current.title);
  if (title.length === 0 || !covers(title, video)) return false;
  // The uploader's channel is not the act, so the act has to appear in the title too.
  return covers(tokens(current.artist), video) || covers(tokens(track.artist), song);
}

/**
 * The name a video plays under. Upload titles carry the act, marketing words and a
 * translated reading; the dock, now playing and Discord RPC should show the song.
 * Only those parts are removed, so "Song (Part 2)" keeps its bracket.
 */
export function videoDisplayTitle(title: string, artist: string): string {
  const value = title.normalize("NFKC").trim();
  const lead = artist.normalize("NFKC").trim();
  const withoutAct =
    lead && value.toLowerCase().startsWith(lead.toLowerCase()) ? value.slice(lead.length) : value;
  return (
    withoutAct
      .replace(
        /\b(?:official(?:\s+music)?(?:\s+(?:video|audio|mv|m\/v))?|lyrics?(?:\s+video)?|visuali[sz]er|m\/v|mv)\b/gi,
        " ",
      )
      // A bracketed group with no Latin letters is a translation of the name.
      .replace(/[\(\[]\s*([^\)\]]*)\s*[\)\]]/g, (group, inside: string) =>
        /[a-z]/i.test(inside) ? group : " ",
      )
      .replace(/["'“”‘’]/g, " ")
      .replace(/^[\s\-–—:|]+/, "")
      .replace(/\s+/g, " ")
      .trim() || title.trim()
  );
}

/**
 * Identity shown while a video plays. Opening the video of the song already playing keeps
 * the song's own name and artist, so the dock, the now playing page and Discord RPC do not
 * suddenly show an upload title like "KATSEYE (캣츠아이) 'Gnarly' Official MV".
 */
export function musicVideoPlayback(
  track: MusicTrack,
  live: { current: MusicTrack | null },
): MusicTrack {
  if (live.current && sameRecording(live.current, track)) {
    return { ...track, title: live.current.title, artist: live.current.artist };
  }
  const title = videoDisplayTitle(track.title, track.artist);
  return title && title !== track.title ? { ...track, title } : track;
}

/**
 * Opening the video of the song already playing must not replace its queue with the
 * related-video list it was opened from, or Up Next loses the listener's tracks. A queue
 * with nothing after the current song has nothing to protect, so the opened list is used
 * and the video page still offers something to watch next.
 */
export function musicWatchQueue(
  track: MusicTrack,
  offered: readonly MusicTrack[],
  live: { current: MusicTrack | null; queue: readonly MusicTrack[]; queueIndex: number },
): MusicTrack[] {
  const hasFollowing =
    live.queueIndex >= 0 ? live.queueIndex < live.queue.length - 1 : live.queue.length > 1;
  const keepLive = live.current !== null && hasFollowing && sameRecording(live.current, track);
  return [...(keepLive ? live.queue : offered)];
}
