import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";

test("PublicMetaDB Stage 2 pauses to the verified TMDB episode, not the parent MAL entry", async () => {
  const saves: any[] = [];
  let inferred = 0;
  let position = 320;
  const handlers = new Map<string, () => void>();
  const hook = hookHarness(
    "src/lib/publicmetadb/scrobble-hook.ts",
    "usePublicMetaDbScrobble",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
      "@/lib/settings": {
        useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }),
      },
      "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
      "./ids": {
        resolvePmdbEpisodeTarget: async () => {
          inferred++;
          return { id_type: "mal", id_value: "14719", media_type: "tv", season: 6, episode: 1 };
        },
        resolvePmdbTarget: async () => null,
      },
      "./scrobble": {
        startPmdbPlayback: () => ({ id: "identity-test-session", watched: false, marking: false }),
        endPmdbPlayback: () => {},
        syncPmdbPlayback: async () => true,
        pmdbSaveResume: async (target: any, pos: number) => {
          saves.push({ target, pos });
          return { action: "saved" };
        },
        pmdbDeleteResumeForTarget: async () => true,
      },
      "./pending-sync": {
        recordPendingResume: () => {},
        syncPendingResume: async (target: any, pos: number) => { saves.push({ target, pos }); return true; },
      },
      "./history": { markPmdbWatched: async () => true },
    },
    {
      Date: { now: () => 200_000 },
      window: {
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: () => 2,
        clearTimeout: () => {},
        addEventListener: (name: string, cb: () => void) => handlers.set(name, cb),
        removeEventListener: (name: string) => handlers.delete(name),
      },
    },
  );
  const src = {
    meta: { id: "mal:14719", name: "JoJo", type: "series" },
    episode: { season: 6, episode: 1, kitsuStreamId: "kitsu:49847:1" },
  };
  const snap = { status: "playing", positionSec: position, durationSec: 1000 };
  const verifiedTarget = {
    tmdb_id: 45790, media_type: "tv", season: 6, episode: 1,
  };
  const proof = {
    work: { entryId: "kitsu:49847", entryEpisode: 1 },
    episode: { ...src.episode, sourceMetaId: "kitsu:49847" },
    pmdbTarget: verifiedTarget,
    traktTarget: null,
  };
  hook.render({ src, snap, liveScrobble: { phase: "ready", proof } });
  await flushPromises();
  hook.render({ src, snap: { ...snap, status: "paused" },
    liveScrobble: { phase: "ready", proof } });
  await flushPromises();
  assert.equal(inferred, 0, "do not resolve a different MAL episode when exact TMDB proof exists");
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].target, verifiedTarget);
  assert.equal(saves[0].pos, 320_000);
  position = 0;
  hook.unmount();
});

test("PMDB does not write while shared anime identity is still resolving", async () => {
  const hook = hookHarness(
    "src/lib/publicmetadb/scrobble-hook.ts",
    "usePublicMetaDbScrobble",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => 300 },
      "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
      "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
      "./ids": { resolvePmdbEpisodeTarget: async () => null, resolvePmdbTarget: async () => null },
      "./scrobble": {
        startPmdbPlayback: () => ({ id: "identity-test-session", watched: false, marking: false }),
        endPmdbPlayback: () => {},
        syncPmdbPlayback: async () => true, pmdbSaveResume: async () => { throw Error("must not write"); }, pmdbDeleteResumeForTarget: async () => false },
      "./pending-sync": { syncPendingResume: async () => { throw Error("must not sync"); }, recordPendingResume: () => {} },
      "./history": { markPmdbWatched: async () => false },
    },
    {
      Date: { now: () => 200_000 },
      window: {
        setInterval: () => 1, clearInterval: () => {},
        setTimeout: () => 2, clearTimeout: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
      },
    },
  );
  hook.render({
    src: {
      meta: { id: "mal:14719", type: "series" },
      episode: { season: 6, episode: 1 },
    },
    snap: { status: "paused", positionSec: 300, durationSec: 1000 },
    liveScrobble: { phase: "resolving", proof: null },
  });
  await flushPromises();
  hook.unmount();
});


test("PublicMetaDB flushes A's last progress when B starts resolving", async () => {
  const saves: Array<{ id: number; pos: number }> = [];
  const timers = new Map<number, () => void>();
  let now = 200_000;
  let position = 300;
  let nextTimer = 0;
  const hook = hookHarness("src/lib/publicmetadb/scrobble-hook.ts", "usePublicMetaDbScrobble", {
    "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
    "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
    "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
    "./ids": {
      resolvePmdbEpisodeTarget: async (_meta: string, ep: any) => ({
        tmdb_id: ep.episode === 1 ? 45790 : 99999,
        media_type: "tv", season: ep.season, episode: ep.episode,
      }),
      resolvePmdbTarget: async () => null,
    },
    "./scrobble": {
      startPmdbPlayback: () => ({ id: "identity-test-session", watched: false, marking: false }),
      endPmdbPlayback: () => {},
      syncPmdbPlayback: async () => true,
      pmdbSaveResume: async (target: any, pos: number) => {
        saves.push({ id: target.tmdb_id, pos });
        return { action: "saved" };
      },
      pmdbDeleteResumeForTarget: async () => true,
    },
    "./pending-sync": {
      recordPendingResume: () => {},
      syncPendingResume: async (target: any, pos: number) => { saves.push({ id: target.tmdb_id, pos }); return true; },
    },
    "./history": { markPmdbWatched: async () => true },
  }, {
    Date: { now: () => now },
    window: {
      setInterval: (cb: () => void) => {
        const id = ++nextTimer;
        timers.set(id, cb);
        return id;
      },
      clearInterval: (id: number) => timers.delete(id),
      setTimeout: () => ++nextTimer,
      clearTimeout: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const srcA = {
    meta: { id: "tt2359704", name: "JoJo", type: "series" },
    episode: { season: 6, episode: 1 },
  };
  const targetA = { tmdb_id: 45790, media_type: "tv", season: 6, episode: 1 };
  const proof = {
    work: { entryId: "kitsu:49847", entryEpisode: 1 },
    episode: { ...srcA.episode, sourceMetaId: "kitsu:49847" },
    pmdbTarget: targetA, traktTarget: null,
  };
  const snap = { status: "playing", positionSec: 300, durationSec: 1000 };
  hook.render({ src: srcA, snap, liveScrobble: { phase: "ready", proof } });
  await flushPromises();
  // A has an unsaved 45 seconds since its last periodic checkpoint. The
  // interval observes the position but does not meet the save-time threshold.
  now += 12_000;
  position = 345;
  for (const timer of timers.values()) timer();
  await flushPromises();
  assert.equal(saves.length, 0, "A's newer position has not been periodically saved");
  position = 0;
  hook.render({
    src: { ...srcA, episode: { season: 6, episode: 2 } },
    snap: { status: "loading", positionSec: 0, durationSec: 0 },
    liveScrobble: { phase: "resolving", proof: null },
  });
  await flushPromises();
  assert.deepEqual(saves, [{ id: 45790, pos: 345_000 }],
    "switch flush uses outgoing A eligibility and verified target, not B's resolving state");
  hook.unmount();
});


test("PublicMetaDB flushes A after resolving to fallback with proof null, even when target effect does not rerun", async () => {
  const saves: Array<{ id: number; pos: number }> = [];
  const timers = new Map<number, () => void>();
  let now = 200_000;
  let position = 300;
  let nextTimer = 0;
  const hook = hookHarness("src/lib/publicmetadb/scrobble-hook.ts", "usePublicMetaDbScrobble", {
    "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
    "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
    "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
    "./ids": {
      resolvePmdbEpisodeTarget: async (_meta: string, ep: any) => ({
        tmdb_id: ep.episode === 1 ? 45790 : 99999,
        media_type: "tv", season: ep.season, episode: ep.episode,
      }),
      resolvePmdbTarget: async () => null,
    },
    "./scrobble": {
      startPmdbPlayback: () => ({ id: "identity-test-session", watched: false, marking: false }),
      endPmdbPlayback: () => {},
      syncPmdbPlayback: async () => true,
      pmdbSaveResume: async (target: any, pos: number) => {
        saves.push({ id: target.tmdb_id, pos });
        return { action: "saved" };
      },
      pmdbDeleteResumeForTarget: async () => true,
    },
    "./pending-sync": {
      recordPendingResume: () => {},
      syncPendingResume: async (target: any, pos: number) => { saves.push({ id: target.tmdb_id, pos }); return true; },
    },
    "./history": { markPmdbWatched: async () => true },
  }, {
    Date: { now: () => now },
    window: {
      setInterval: (cb: () => void) => { const id = ++nextTimer; timers.set(id, cb); return id; },
      clearInterval: (id: number) => timers.delete(id),
      setTimeout: () => ++nextTimer, clearTimeout: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
    },
  });
  const srcA = {
    meta: { id: "tt2359704", name: "JoJo", type: "series" },
    episode: { season: 6, episode: 1 },
  };
  const snap = { status: "playing", positionSec: 300, durationSec: 1000 };
  const pending = { phase: "resolving", proof: null } as const;
  const fallback = { phase: "ready", proof: null } as const;
  hook.render({ src: srcA, snap, liveScrobble: pending });
  await flushPromises();
  // Stage 1 has finished, but no verified work was found. Both proof and
  // verifiedTarget remain null, so the target effect will NOT reinitialize A.
  hook.render({ src: srcA, snap, liveScrobble: fallback });
  await flushPromises();
  now += 12_000;
  position = 345;
  for (const timer of timers.values()) timer();
  await flushPromises();
  assert.equal(saves.length, 0, "A has accumulated progress that is not yet saved");
  position = 0;
  hook.render({
    src: { ...srcA, episode: { season: 6, episode: 2 } },
    snap: { status: "loading", positionSec: 0, durationSec: 0 },
    liveScrobble: pending,
  });
  await flushPromises();
  assert.deepEqual(saves, [{ id: 45790, pos: 345_000 }],
    "outgoing A must save using its latest fallback eligibility, not B's resolving state");
  hook.unmount();
});
