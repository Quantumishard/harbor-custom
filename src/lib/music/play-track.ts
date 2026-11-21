import { playMusic, warmMusicSourceCache } from "./player";
import { readMusicPreference } from "./preferences";
import { cancelMusicQueueAutomation } from "./queue-automation";
import { adoptRequestedIdentity } from "./queue-source";
import { startsFromPreferredSource } from "./source-choice";
import { getMusicSourceCandidates, musicSourcePriority, preferredMusicSource } from "./sources";
import { withTimeout } from "@/lib/progressive-rows";
import type { MusicTrack } from "./types";

export const MUSIC_SOURCE_KEY = "harbor.music.preferred-source.v1";
export const MUSIC_SOURCE_REQUIRED = "harbor:music-playback-source-required";

export type ResolvedMusicPlayback = { track: MusicTrack; queue: MusicTrack[] };

const PREFERRED_LOOKUP_MS = 9_000;

/**
 * Resolution is headless, so anything outside the Music view can start a song without the
 * picker's React context and without sending the listener to another page.
 */
export async function resolveAndPlayMusicTrack(
  track: MusicTrack,
  queue: MusicTrack[] = [track],
): Promise<ResolvedMusicPlayback | null> {
  cancelMusicQueueAutomation();
  if (track.playbackUrl) {
    await playMusic(track, queue);
    return { track, queue };
  }
  // Start as soon as the source is ready; searching other connectors must not gate playback.
  if (startsFromPreferredSource(track, preferredMusicSource())) {
    await playMusic(track, queue);
    return { track, queue };
  }
  const preferred = preferredMusicSource();
  // Ask only the preferred source first: when it carries the recording, playback starts right
  // away and the cross-source fan-out below runs afterwards in the background for fallbacks.
  const preferredMatch = await withTimeout(
    getMusicSourceCandidates(track, preferred),
    PREFERRED_LOOKUP_MS,
  )
    .then((candidates) =>
      candidates.find(
        (candidate) => candidate.connectorId === preferred && candidate.health !== "offline",
      ),
    )
    .catch(() => undefined);
  if (preferredMatch) {
    warmMusicSourceCache(track);
    const selected = adoptRequestedIdentity(preferredMatch.track, track);
    const selectedQueue = queue.map((item) =>
      item.id === track.id && item.connectorId === track.connectorId ? selected : item,
    );
    await playMusic(selected, selectedQueue);
    return { track: selected, queue: selectedQueue };
  }
  // No match on the preferred source: fall back to the full fan-out and pick the best source.
  const storedPreferred = readMusicPreference(MUSIC_SOURCE_KEY);
  const candidates = await getMusicSourceCandidates(track);
  const usable = candidates.filter((candidate) => candidate.health !== "offline");
  const match =
    usable.find((candidate) => candidate.connectorId === storedPreferred) ??
    [...usable].sort(
      (left, right) =>
        musicSourcePriority(left.connectorId) - musicSourcePriority(right.connectorId),
    )[0];
  if (!match) return null;
  const selected = adoptRequestedIdentity(match.track, track);
  const selectedQueue = queue.map((item) =>
    item.id === track.id && item.connectorId === track.connectorId ? selected : item,
  );
  await playMusic(selected, selectedQueue);
  return { track: selected, queue: selectedQueue };
}
