import type { MusicTrack } from "./types";

type Candidate = { connectorId: string; track: MusicTrack };
type Pinned = { connectorId: string; id: string } | null;

/**
 * Picks the connector that answers for a recording. The source chosen in Settings outranks the
 * upload that last answered for this song: changing the preference is a newer, deliberate
 * decision than a remembered per-song pin. The pin still settles the case where the preferred
 * source has no matching recording.
 */
export function selectSourceCandidate<T extends Candidate>(
  ranked: readonly T[],
  preferred: string | null | undefined,
  pinned: Pinned,
  workingSource: string | null | undefined,
): T | undefined {
  if (preferred) {
    const match = ranked.find((candidate) => candidate.connectorId === preferred);
    if (match) return match;
  }
  if (pinned) {
    const exact = ranked.find(
      (candidate) =>
        candidate.connectorId === pinned.connectorId && candidate.track.id === pinned.id,
    );
    if (exact) return exact;
    const remembered = ranked.find((candidate) => candidate.connectorId === pinned.connectorId);
    if (remembered) return remembered;
  }
  return ranked.find((candidate) => candidate.connectorId === workingSource) ?? ranked[0];
}
