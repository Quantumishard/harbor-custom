import type { PlayerSnapshot } from "./bridge";

/** The completion ratio Harbor uses for watched state and resume ownership. */
export const PLAYBACK_FINISH_RATIO = 0.85;
const END_RATIO = PLAYBACK_FINISH_RATIO;

export function isNaturalEnd(snap: PlayerSnapshot, positionSec: number): boolean {
  if (snap.status !== "ended") return false;
  if (!Number.isFinite(snap.durationSec) || snap.durationSec <= 0) return true;
  return positionSec / snap.durationSec >= END_RATIO;
}

export function isTruncatedEnd(snap: PlayerSnapshot, positionSec: number): boolean {
  return snap.status === "ended" && !isNaturalEnd(snap, positionSec);
}

/**
 * Whether playback reached the point that counts as finished for this session.
 * The player-exit resume write and the resume autosave must share this rule, or
 * closing right after an episode ends resurrects a resume the autosave cleared.
 */
export function isPlaybackFinished(snap: PlayerSnapshot, positionSec: number): boolean {
  if (snap.durationSec > 0 && positionSec / snap.durationSec >= PLAYBACK_FINISH_RATIO) return true;
  return isNaturalEnd(snap, positionSec);
}
