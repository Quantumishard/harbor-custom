import { useSyncExternalStore } from "react";
import { getMusicState, subscribeMusic } from "./player";
import { createMusicPlaybackSelection } from "./player-selection";

const snapshot = createMusicPlaybackSelection(getMusicState);

/** Use the full player hook only for transport, progress, and timed lyrics. */
export function useMusicPlayback() {
  return useSyncExternalStore(subscribeMusic, snapshot, snapshot);
}

/**
 * The playback clock on its own. A component that draws something timed subscribes here instead
 * of taking the whole player, so a position tick re-renders only that component and React bails
 * out while the number has not changed.
 */
export function useMusicClock(): number {
  return useSyncExternalStore(
    subscribeMusic,
    () => getMusicState().currentTime,
    () => getMusicState().currentTime,
  );
}
