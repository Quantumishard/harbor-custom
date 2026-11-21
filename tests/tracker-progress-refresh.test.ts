import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  TRACKER_PROGRESS_EVENT,
  notifyTrackerProgress,
} from "../src/lib/tracker-progress-events.ts";

test("a tracker completion dispatches a provider-tagged event", () => {
  const events: Array<{ type: string; detail?: unknown }> = [];
  const previousWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    dispatchEvent: (event: Event & { detail?: unknown }) => {
      events.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  try {
    notifyTrackerProgress("trakt");
    notifyTrackerProgress("simkl");
  } finally {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = previousWindow;
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [TRACKER_PROGRESS_EVENT, TRACKER_PROGRESS_EVENT],
  );
  assert.deepEqual(
    events.map((event) => (event.detail as { source: string }).source),
    ["trakt", "simkl"],
  );
});

test("confirmed tracker writes notify and Continue Watching listens", () => {
  const traktResolve = readFileSync(resolve("src/lib/trakt/resolve.ts"), "utf8");
  assert.match(traktResolve, /notifyTrackerProgress\("trakt"\)/);

  const simklFallback = readFileSync(resolve("src/lib/simkl/record-watched.ts"), "utf8");
  assert.match(simklFallback, /notifyTrackerProgress\("simkl"\)/);

  const simklScrobble = readFileSync(resolve("src/lib/simkl/scrobble.ts"), "utf8");
  assert.match(simklScrobble, /notifyTrackerProgress\("simkl"\)/);

  const externalCw = readFileSync(resolve("src/lib/feed/external-cw.ts"), "utf8");
  assert.match(externalCw, /TRACKER_PROGRESS_EVENT/);
  assert.match(externalCw, /refreshExternalCw\(true, "data"\)/);
});

test("player close does not resurrect a finished episode's resume", () => {
  const exit = readFileSync(resolve("src/views/player/hooks/use-player-exit.ts"), "utf8");
  assert.match(exit, /isPlaybackFinished/);
  assert.match(exit, /if \(!isPlaybackFinished\(snap, pos\)\) \{[\s\S]*saveResumeMs\(/);

  const autosave = readFileSync(resolve("src/views/player/hooks/use-resume-autosave.ts"), "utf8");
  assert.match(autosave, /const finished = isPlaybackFinished\(sn, pos\);/);
});
