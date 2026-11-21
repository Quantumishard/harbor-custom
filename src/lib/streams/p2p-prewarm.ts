import { magnetFromHash } from "@/lib/debrid/types";
import type { AddResult } from "@/lib/torrent/local-engine";
import { scheduleAbandonedTorrentRemoval, torrentEngineAdd } from "@/lib/torrent/local-engine";
import {
  directStreamAvailable,
  isHostedTorrentServerUrl,
  trackersFromSources,
} from "@/lib/torrent/stremio-stream";

/**
 * A source focused or hovered this long is likely about to be played. Keep this
 * long enough that sweeping the pointer down the source list does not queue an
 * add per row; the play handler prewarms immediately when the user commits.
 */
export const INTENT_PREWARM_DELAY_MS = 1000;
/** An intent prewarm nobody played within this window is removed again. */
export const INTENT_PREWARM_ABANDON_MS = 90_000;
/** Safety net for the play path's own prewarm if playback never claims it. */
export const PLAY_PREWARM_ABANDON_MS = 120_000;
/** Repeat prewarms of the same infohash are skipped for this long. */
const REPREWARM_COOLDOWN_MS = 2 * 60_000;

type PrewarmDeps = {
  add: (magnet: string, trackers: string[], fileIdx?: number) => Promise<AddResult | null>;
  abandon: (infoHash: string, delayMs?: number) => void;
};

const defaultDeps: PrewarmDeps = {
  add: (magnet, trackers, fileIdx) => torrentEngineAdd(magnet, trackers, fileIdx, "prewarm"),
  abandon: scheduleAbandonedTorrentRemoval,
};

let deps: PrewarmDeps = defaultDeps;
const cooldown = new Map<string, number>();
const inflight = new Map<string, Promise<AddResult | null>>();
const abandonTimers = new Map<string, ReturnType<typeof setTimeout>>();
// A hover/focus prewarm is a one-at-a-time bet on where the pointer will land:
// browsing 120 rows must not leave 120 warm torrents (and their cache files)
// behind, so only the newest intent prewarm stays alive.
let intentKey: string | null = null;

export type PrewarmOptions = { abandonAfterMs?: number; intent?: boolean };

/** The minimum a stream must expose to be prewarmed. */
export type PrewarmSource = {
  infoHash?: string | null;
  url?: string | null;
  fileIdx?: number;
  sources?: string[];
};

function keyOf(stream: { infoHash?: string | null } | null | undefined): string | null {
  const hash = stream?.infoHash?.trim().toLowerCase();
  return hash ? hash : null;
}

function clearAbandonTimer(key: string): void {
  const timer = abandonTimers.get(key);
  if (timer != null) {
    clearTimeout(timer);
    abandonTimers.delete(key);
  }
}

function abandonKey(key: string): void {
  if (intentKey === key) intentKey = null;
  clearAbandonTimer(key);
  // A later play of the same source may prewarm again immediately; without this
  // the cooldown would force it onto the slower direct-add fallback.
  cooldown.delete(key);
  const running = inflight.get(key);
  if (!running) {
    deps.abandon(key);
    return;
  }
  // The add may still be resolving; remove it only once it exists.
  void running.then((added) => {
    if (added) deps.abandon(added.info_hash);
  });
}

/** Make this source the only warm hover/focus prewarm, discarding the previous one. */
function claimIntentKey(key: string): void {
  if (intentKey === key) return;
  const previous = intentKey;
  intentKey = key;
  if (previous) abandonKey(previous);
}

/**
 * Drop the hover/focus prewarm when the picker stops using it (for example when
 * the user leaves the source list), so it cannot outlive the list that started
 * it until the abandon timer fires.
 */
export function releaseIntentPrewarm(): void {
  const key = intentKey;
  intentKey = null;
  if (key) abandonKey(key);
}

/**
 * Start metadata resolution and peer discovery for a P2P source before the
 * player is committed to it. The torrent is added paused, so no file data moves
 * until playback asks for bytes, and the play path's own add then finds it
 * already managed.
 *
 * Used while the consent prompt is open, when a source row gains focus or is
 * hovered, and when the play handler commits to a P2P source with auto-consent
 * (where no prompt is shown at all).
 *
 * Returns the shared in-flight add, or null when this source is not eligible or
 * was prewarmed moments ago.
 */
export function prewarmP2pStream(
  stream: PrewarmSource,
  options?: PrewarmOptions,
): Promise<AddResult | null> | null {
  if (typeof window === "undefined") return null;
  const key = keyOf(stream);
  if (!key || !directStreamAvailable(stream)) return null;
  // A plain URL source is resolved directly; only a hosted torrent-server URL
  // still ends up on the local engine.
  if (stream.url && !isHostedTorrentServerUrl(stream.url)) return null;
  if (options?.intent) claimIntentKey(key);
  const running = inflight.get(key);
  if (running) return running;
  const now = Date.now();
  const last = cooldown.get(key);
  if (last != null && now - last < REPREWARM_COOLDOWN_MS) return null;
  cooldown.set(key, now);
  const fileIdx =
    typeof stream.fileIdx === "number" && stream.fileIdx >= 0 ? stream.fileIdx : undefined;
  const pending = deps
    .add(magnetFromHash(key), trackersFromSources(stream.sources), fileIdx)
    .catch(() => null)
    .then((added) => {
      inflight.delete(key);
      if (!added) cooldown.delete(key);
      return added;
    });
  inflight.set(key, pending);
  if (options?.abandonAfterMs != null) {
    clearAbandonTimer(key);
    abandonTimers.set(
      key,
      setTimeout(() => {
        abandonTimers.delete(key);
        abandonKey(key);
      }, options.abandonAfterMs),
    );
  }
  return pending;
}

/** Remove a prewarmed torrent unless playback claimed it in the meantime. */
export function abandonPrewarmedStream(
  stream: { infoHash?: string | null } | null | undefined,
): void {
  const key = keyOf(stream);
  if (key) abandonKey(key);
}

export function __setPrewarmDepsForTest(next: PrewarmDeps | null): void {
  deps = next ?? defaultDeps;
}

export function __resetPrewarmForTest(): void {
  deps = defaultDeps;
  intentKey = null;
  cooldown.clear();
  inflight.clear();
  for (const timer of abandonTimers.values()) clearTimeout(timer);
  abandonTimers.clear();
}
