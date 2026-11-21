export const TRACKER_PROGRESS_EVENT = "harbor:tracker-progress-updated";

export type TrackerProgressSource = "trakt" | "simkl";

/**
 * Announce that a tracker confirmed new watched progress for the active account.
 * Continue Watching refreshes its provider caches when it sees this event, so the
 * freshly completed episode is available without waiting for a stale poll.
 */
export function notifyTrackerProgress(source: TrackerProgressSource): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TRACKER_PROGRESS_EVENT, { detail: { source } }));
}
