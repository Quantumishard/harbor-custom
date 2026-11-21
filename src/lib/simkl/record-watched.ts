import { activeProfileId } from "@/lib/active-profile-id";
import { getSession } from "./session";
import { resolveForMeta } from "@/lib/tracker-resolve";
import { resolveSimklEpisodeTarget, stremioIdToSimklTarget } from "./ids";
import { addToHistory, markEpisodesWatched } from "./history";
import { animeIdentity, type ScrobbleInfo } from "./scrobble-body";
import type { PlayerSrc } from "@/lib/view";
import { notifyTrackerProgress } from "@/lib/tracker-progress-events";

const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;

/** Wake Continue Watching once the fallback write is confirmed. */
function done(value: boolean): boolean {
  if (value) notifyTrackerProgress("simkl");
  return value;
}

/**
 * Directly records the finished item in Simkl's watch history as a fallback,
 * because the beacon is fire-and-forget and would otherwise leave the item
 * stuck in "watching" if its request is ever lost.
 *
 * Returns true when the write was confirmed so callers can persist the intent
 * for a later retry instead of dropping it.
 */
export async function recordWatchedFallback(
  metaId: string,
  episode: PlayerSrc["episode"] | undefined,
  info?: ScrobbleInfo,
  verifiedOnly = false,
): Promise<boolean> {
  const profile = activeProfileId();
  const session = getSession();
  const owned = () => session != null && getSession() === session && activeProfileId() === profile;
  if (!owned()) return false;
  // The episode knows which anime entry aired it; that is the entry Simkl can
  // match, not the row's umbrella IMDb show.
  const anime = animeIdentity(episode);
  if (anime?.number != null) {
    if (await markEpisodesWatched({ [anime.scheme]: anime.id }, 1, [anime.number]))
      return done(true);
  }
  // A failed verified native write must not become a guessed umbrella show
  // write, even on terminal completion or after a later pending replay.
  if (verifiedOnly) return false;
  const r = stremioIdToSimklTarget(metaId, episode);
  const t = r.ok
    ? r.target
    : episode
      ? await resolveSimklEpisodeTarget(metaId, episode, info?.imdb)
      : null;
  if (!owned() || !t) return false;
  if (t.kind === "episode") {
    if (await markEpisodesWatched(t.show.ids, t.season, [t.number])) return done(true);
    if (!owned() || ANIME_ID.test(metaId)) return false;
    const resolved = await resolveForMeta(metaId, t.season, t.number);
    if (!owned() || !resolved.ok) return false;
    return done(
      await markEpisodesWatched(resolved.episode.showIds, resolved.episode.season, [
        resolved.episode.number,
      ]),
    );
  }
  if (t.kind === "anime-episode")
    return done(await markEpisodesWatched(t.anime.ids, t.season, [t.number]));
  return done(await addToHistory(t, metaId));
}
