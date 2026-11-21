import assert from "node:assert/strict";
import test from "node:test";
import { buildCwShareSnapshot } from "../src/lib/cw-share-snapshot.ts";
import type { LibraryItem } from "../src/lib/stremio.ts";

const done = {
  _id: "tt20969586",
  type: "movie",
  name: "Thunderbolts*",
  _mtime: "2026-01-10T10:00:00Z",
  _ctime: "2025-05-01T10:00:00Z",
  state: {
    flaggedWatched: 1,
    timeOffset: 7_598_340,
    duration: 7_609_977,
    lastWatched: "2026-01-10T10:00:00Z",
    video_id: "tt20969586",
  },
  removed: false,
  temp: false,
  poster: "https://example.com/user-private-poster?auth=secret",
  providerPlaybackIds: { simkl: "PRIVATE-PLAYBACK" },
  authKey: "SENSITIVE-TOKEN",
} as LibraryItem;

const old = {
  ...done,
  _id: "tmdb:movie:986056",
  local: true,
  poster: undefined,
  state: {
    ...done.state,
    flaggedWatched: 0,
    timeOffset: 500_000,
    video_id: "https://private-stream?token=sensitive",
    lastWatched: "2025-11-10T10:00:00Z",
  },
};

test("Copy CW preserves completed input checkpoints even when only other rows are displayed", () => {
  const sample = buildCwShareSnapshot({
    sources: { library: [done], local: [old], external: [], manual: [] },
    eligible: [old],
    displayed: [],
    flags: {
      perProfile: false, sharedHidden: false, accountProvider: "stremio",
      enabledSources: { library: true, local: true, simkl: false, trakt: false },
    },
  });
  assert.equal(sample.format, "harbor-cw-snapshot");
  assert.equal(sample.version, 1);
  assert.equal(sample.inputs.library.length, 1);
  assert.equal((sample.inputs.library[0].state as any)?.flaggedWatched, 1);
  assert.equal((sample.inputs.local[0].state as any)?.offset, 500_000);
  assert.equal(sample.displayed.length, 0);
  const json = JSON.stringify(sample);
  for (const secret of ["SENSITIVE-TOKEN", "PRIVATE-PLAYBACK", "private-poster", "private-stream"]) {
    assert.equal(json.includes(secret), false, `must not share ${secret}`);
  }
  assert.equal((sample.inputs.local[0].state as any)?.videoId, "[redacted-id]");
});

test("Copy CW keeps original grouped members without leaking provider credentials", () => {
  const merged = {
    ...old,
    cwMembers: [done, old],
    external: undefined,
  };
  const sample = buildCwShareSnapshot({
    sources: { library: [], local: [], external: [], manual: [] },
    eligible: [merged], displayed: [merged],
    flags: {
      perProfile: true, sharedHidden: true, accountProvider: "stremio",
      enabledSources: { library: false, local: true },
    },
  });
  assert.equal((sample.displayed[0].members as unknown[]).length, 2);
  assert.equal(sample.flags.sharedHidden, true);
  assert.equal(JSON.stringify(sample).includes("SENSITIVE-TOKEN"), false);
});
