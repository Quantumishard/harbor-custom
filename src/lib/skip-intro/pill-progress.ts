import type { SkipSegment } from "./types";

/**
 * Where a segment stops counting as active. activeSegment cuts this tail so a
 * skip never fires on a segment that is effectively over, and the pill's line
 * has to land on the same instant: any other end and the line either keeps
 * running after the button is gone or stops short of its own finish.
 */
export const SKIP_SEGMENT_END_GUARD_SEC = 0.75;

/**
 * Progress for the line while the pill lives as long as its segment does: no
 * auto-hide window, or the credits pill holding the Up Next card.
 *
 * The line starts empty where the pill appeared, so resuming mid-intro still
 * gets a full bar instead of one that is already two thirds gone. Position is
 * playback time, so pausing freezes this line and seeking moves it.
 */
export function resolveSkipPillProgress({
  segment,
  positionSec,
  appearedAtSec,
}: {
  segment: SkipSegment;
  positionSec: number;
  appearedAtSec: number;
}): number {
  const guardEndSec = segment.endSec - SKIP_SEGMENT_END_GUARD_SEC;
  const startSec = Math.max(segment.startSec, appearedAtSec);
  const spanSec = guardEndSec - startSec;
  if (!(spanSec > 0)) return 1;
  return Math.max(0, Math.min(1, (positionSec - startSec) / spanSec));
}

/**
 * The auto-hide window, in wall-clock milliseconds.
 *
 * This is a timer, not a progress bar: ten seconds means ten seconds of real
 * time whether the video is playing, paused or being seeked. It is capped by how
 * much segment is left so a pill that appears near a segment's end still has its
 * line land where the segment would end first.
 */
export function resolveSkipPillWindowMs({
  segment,
  appearedAtSec,
  hideSec,
}: {
  segment: SkipSegment;
  appearedAtSec: number;
  hideSec: number;
}): number {
  if (!(hideSec > 0)) return 0;
  const guardEndSec = segment.endSec - SKIP_SEGMENT_END_GUARD_SEC;
  const startSec = Math.max(segment.startSec, appearedAtSec);
  const leftSec = guardEndSec - startSec;
  if (!(leftSec > 0)) return 0;
  return Math.round(Math.min(hideSec, leftSec) * 1000);
}

/** Wall-clock progress of a window: empty at its start, full at its end. */
export function resolveSkipPillWindowProgress(elapsedMs: number, windowMs: number): number {
  if (!(windowMs > 0)) return 0;
  return Math.max(0, Math.min(1, elapsedMs / windowMs));
}
