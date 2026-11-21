import { BUILD_ID } from "@/lib/build-info";
import type { LibraryItem } from "@/lib/stremio";

/** A portable, secret-free snapshot of the exact source checkpoints that fed CW. */
export type CwShareSources = {
  library: readonly LibraryItem[];
  local: readonly LibraryItem[];
  external: readonly LibraryItem[];
  manual: readonly LibraryItem[];
};
export type CwShareOptions = {
  sources: CwShareSources;
  eligible: readonly LibraryItem[];
  displayed: readonly LibraryItem[];
  flags: {
    perProfile: boolean;
    sharedHidden: boolean;
    accountProvider: string;
    enabledSources: Record<string, boolean>;
  };
};

function safeId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Never copy URLs, file paths, arbitrary encoded stream data, or credentials.
  return /^[a-z0-9][a-z0-9:._-]{0,175}$/i.test(value) ? value : "[redacted-id]";
}

function rowSnapshot(item: LibraryItem, depth = 0): Record<string, unknown> {
  const state = item.state;
  return {
    id: safeId(item._id),
    type: item.type,
    name: item.name,
    source: item.local ? "local" : item.manualWatched ? "manual" : item.external ?? "library",
    altIds: item.altIds?.map(safeId),
    isAnime: item.isAnime === true,
    removed: item.removed,
    temp: item.temp,
    mtime: item._mtime,
    ctime: item._ctime,
    upNext: item.upNext === true,
    caughtUp: item.caughtUp === true,
    waitingForAir: item.waitingForAir === true,
    state: state ? {
      season: state.season,
      episode: state.episode,
      videoId: safeId(state.video_id),
      offset: state.timeOffset,
      duration: state.duration,
      flaggedWatched: state.flaggedWatched ?? 0,
      lastWatched: state.lastWatched,
    } : null,
    ...(depth < 2 && item.cwMembers?.length
      ? { members: item.cwMembers.map((member) => rowSnapshot(member, depth + 1)) }
      : {}),
  };
}

/**
 * This is intentionally not the old 500 KB event-log-only CW diagnostic.
 * It contains replayable checkpoints INCLUDING finished movie sources that
 * could have been excluded before the output trace was collected.
 *
 * No auth key, email, profile ID, provider tokens, stream URLs, API keys or
 * local file paths are copied. It *does* include viewing titles and progress.
 */
export function buildCwShareSnapshot({
  sources, eligible, displayed, flags,
}: CwShareOptions) {
  return {
    format: "harbor-cw-snapshot",
    version: 1,
    build: BUILD_ID,
    capturedAt: new Date().toISOString(),
    privacy: "Includes viewing titles, timestamps and playback progress. Review before sharing.",
    flags,
    inputs: {
      library: sources.library.map((row) => rowSnapshot(row)),
      local: sources.local.map((row) => rowSnapshot(row)),
      external: sources.external.map((row) => rowSnapshot(row)),
      manual: sources.manual.map((row) => rowSnapshot(row)),
    },
    eligible: eligible.map((row) => rowSnapshot(row)),
    displayed: displayed.map((row) => rowSnapshot(row)),
  };
}
