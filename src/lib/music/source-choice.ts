import type { MusicTrack } from "./types";

/**
 * A song already carried by the preferred source needs no cross-source lookup: the search only
 * exists to find the recording elsewhere, and waiting for every other connector would delay a
 * play that is ready now. Recovery paths still look for alternatives if this source fails.
 */
export function startsFromPreferredSource(track: MusicTrack, preferred: string): boolean {
  const connector = track.connectorId;
  return (
    Boolean(connector) &&
    connector !== "catalog" &&
    connector === preferred &&
    track.mediaKind !== "video" &&
    !track.playbackUrl
  );
}
