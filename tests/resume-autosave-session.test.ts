import assert from "node:assert/strict";
import test from "node:test";
import {
  playbackParams,
  playbackPersistenceHarness as resumeAutosaveHarness,
} from "./helpers/playback-persistence-harness.ts";

test("unrelated rerenders cannot replace the live clock with a stale snapshot before exit", () => {
  const h = resumeAutosaveHarness();
  const p = playbackParams();
  h.render(p);
  const playing = {
    ...p,
    snap: { ...p.snap, status: "playing", positionSec: 30, durationSec: 3600 },
  };
  h.render(playing);
  h.clock(605);
  h.render({ ...playing, snap: { ...playing.snap, subText: "A new subtitle" } });
  h.clock(0);
  h.unmount();
  assert.equal(h.writes.at(-1)?.[1], 605000);
});

test("seeking backwards saves the actual new position instead of the furthest position", () => {
  const h = resumeAutosaveHarness();
  const p = playbackParams();
  h.render(p);
  const playing = {
    ...p,
    snap: { ...p.snap, status: "playing", positionSec: 600, durationSec: 3600 },
  };
  h.render(playing);
  h.clock(600);
  h.clock(120);
  h.render(playing);
  h.clock(0);
  h.unmount();
  assert.equal(h.writes.at(-1)?.[1], 120000);
});

test("switching streams does not let the outgoing session overwrite the new source", () => {
  const h = resumeAutosaveHarness();
  let first = playbackParams();
  first.src.streamRef = { infoHash: "yameii", addonId: "aiostreams", releaseGroup: "YAMEII" };
  h.render(first);
  first = {
    ...first,
    snap: { ...first.snap, status: "playing", positionSec: 300, durationSec: 3600 },
  };
  h.render(first);
  h.clock(300);
  h.tick();
  assert.equal(h.history.at(-1)?.[1]?.infoHash, "yameii");

  const switched = {
    ...first,
    src: {
      ...first.src,
      url: "https://media.test/switched.mkv",
      streamRef: { infoHash: "varyg", addonId: "aiostreams", releaseGroup: "VARYG" },
    },
    snap: { ...first.snap, status: "loading", positionSec: 0, durationSec: 0 },
  };
  h.render(switched);
  assert.equal(
    h.history.at(-1)?.[1]?.infoHash,
    "yameii",
    "the outgoing session must not write its old source over the switch",
  );
  const switchedPlaying = {
    ...switched,
    snap: { ...switched.snap, status: "playing", positionSec: 300, durationSec: 3600 },
  };
  h.render(switchedPlaying);
  h.clock(300);
  h.tick();
  assert.equal(h.history.at(-1)?.[1]?.infoHash, "varyg");
  h.unmount();
});

test("episode transition cleanup saves the old source with its old season and duration", () => {
  const h = resumeAutosaveHarness();
  let first = playbackParams();
  h.render(first);
  first = {
    ...first,
    snap: { ...first.snap, status: "playing", positionSec: 300, durationSec: 3600 },
  };
  h.render(first);
  h.clock(300);
  h.tick();
  const second = playbackParams(2, 1);
  h.clock(0);
  h.render(second);
  const saved = h.writes.at(-1);
  assert.deepEqual(saved?.slice(0, 4), ["tt100", 300000, 1, 1]);
  assert.equal(saved?.[4], 1, "do not use the incoming episode's mapped season");
  assert.equal(h.history.at(-1)?.[2], 1, "history must belong to the outgoing season");
  assert.equal(h.watched.length, 0);
});

test("an outgoing episode cannot be finished using the incoming episode's shorter duration", () => {
  const h = resumeAutosaveHarness();
  let first = playbackParams();
  h.render(first);
  first = {
    ...first,
    snap: { ...first.snap, status: "playing", positionSec: 300, durationSec: 3600 },
  };
  h.render(first);
  h.clock(300);
  const next = playbackParams(1, 2);
  h.clock(0);
  h.render({ ...next, snap: { ...next.snap, status: "playing", durationSec: 300 } });
  assert.equal(h.watched.length, 0);
  assert.equal(h.writes.at(-1)?.[1], 300000);
});

test("a new episode ignores the previous playing snapshot until the player resets", () => {
  const h = resumeAutosaveHarness();
  let first = playbackParams();
  h.render(first);
  first = {
    ...first,
    snap: { ...first.snap, status: "playing", positionSec: 3500, durationSec: 3600 },
  };
  h.render(first);
  h.clock(3500);
  h.tick();
  const next = playbackParams(1, 2);
  h.render({ ...next, snap: first.snap });
  h.tick();
  h.pagehide();
  assert.equal(
    h.watched.some((v) => v[2] === 2),
    false,
    "old progress must not finish the new episode",
  );
  assert.equal(
    h.writes.some((v) => v[3] === 2),
    false,
    "old progress must not seed its resume offset",
  );
  h.clock(0);
  h.render(next);
  h.render({
    ...next,
    snap: { ...next.snap, status: "playing", positionSec: 300, durationSec: 3360 },
  });
  h.clock(300);
  h.tick();
  assert.ok(h.writes.some((v) => v[3] === 2 && v[1] === 300000));
  assert.equal(
    h.watched.some((v) => v[2] === 2),
    false,
  );
});

test("teardown after the clock resets keeps the last valid position and snapshot", () => {
  const h = resumeAutosaveHarness();
  let p = playbackParams();
  h.render(p);
  p = { ...p, snap: { ...p.snap, status: "playing", positionSec: 305, durationSec: 3600 } };
  h.render(p);
  h.clock(305);
  h.clock(0);
  h.unmount();
  assert.deepEqual(h.writes.at(-1)?.slice(0, 4), ["tt100", 305000, 1, 1]);
  assert.equal(h.watched.length, 0);
});

test("normal completion still records the watched episode and clears its resume entry", () => {
  const h = resumeAutosaveHarness();
  let p = playbackParams();
  h.render(p);
  p = { ...p, snap: { ...p.snap, status: "playing", positionSec: 3500, durationSec: 3600 } };
  h.render(p);
  h.clock(3500);
  h.tick();
  assert.deepEqual(h.watched[0], ["tt100", 1, 1, true]);
  assert.deepEqual(h.cleared[0], ["tt100", 1, 1, "fixture"]);
  assert.equal(h.synced[0]?.[1], "tt100");
});

test("loading with stale telemetry cannot save progress for an episode that never starts", () => {
  const h = resumeAutosaveHarness();
  const first = playbackParams();
  h.render(first);
  h.render({
    ...first,
    snap: { ...first.snap, status: "playing", positionSec: 3500, durationSec: 3600 },
  });
  h.clock(3500);
  h.tick();
  const next = playbackParams(1, 2);
  h.render({
    ...next,
    snap: { ...next.snap, status: "loading", positionSec: 3500, durationSec: 3600 },
  });
  h.pagehide();
  h.unmount();
  assert.equal(
    h.watched.some((v) => v[2] === 2),
    false,
  );
  assert.equal(
    h.writes.some((v) => v[3] === 2),
    false,
  );
});

test("an ended event losing duration cannot turn five minutes into a completed hour", () => {
  const h = resumeAutosaveHarness();
  const p = playbackParams();
  h.render(p);
  h.render({ ...p, snap: { ...p.snap, status: "playing", positionSec: 300, durationSec: 3600 } });
  h.clock(300);
  h.clock(0);
  h.render({ ...p, snap: { ...p.snap, status: "ended", positionSec: 300, durationSec: 0 } });
  assert.equal(h.watched.length, 0);
  assert.equal(h.writes.at(-1)?.[1], 300000);
});

test("outgoing anime tracker sync uses its own resolved ID and reaches both trackers", async () => {
  const h = resumeAutosaveHarness();
  h.enableAnimeSync();
  const p = playbackParams();
  p.src.meta.id = "tmdb:tv:100";
  h.render(p);
  h.render({ ...p, snap: { ...p.snap, status: "playing", positionSec: 3300, durationSec: 3600 } });
  h.clock(3300);
  h.clock(0);
  h.render(playbackParams(2, 1, { resolvedImdbId: "tt200" }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(h.identityRequests[0]?.slice(0, 2), ["tmdb:tv:100", "tt100"]);
  assert.deepEqual(
    h.trackerProgress.map((v) => v.slice(0, 3)),
    [
      ["anilist", "kitsu:99", 1],
      ["mal", "kitsu:99", 1],
    ],
  );
});


test("verified live scrobble updates AniList and MAL by native cour while retaining the original resume record", () => {
  const h = resumeAutosaveHarness();
  h.enableAnimeSync();
  const p = playbackParams(6, 1);
  p.src.meta.id = "mal:14719";
  p.src.episode = { season: 6, episode: 1, kitsuStreamId: "kitsu:49847:1" } as typeof p.src.episode;
  const proof = {
    work: {
      entryId: "kitsu:49847", entryEpisode: 1,
      aliases: { kitsu: "kitsu:49847", mal: "mal:61469", anilist: "anilist:190327" },
      catalogIds: ["tmdb:tv:45790"], evidence: "pack+window",
    },
  };
  const withProof = { ...p, liveScrobble: { phase: "ready", proof } };
  h.render(withProof);
  h.render({
    ...withProof,
    snap: { ...p.snap, status: "playing", positionSec: 950, durationSec: 1000 },
  });
  h.clock(950);
  h.tick();
  assert.equal(h.trackerProgress.some((write) =>
    write[0] === "anilist" && write[1] === "anilist:190327" && write[2] === 1), true);
  assert.equal(h.trackerProgress.some((write) =>
    write[0] === "mal" && write[1] === "mal:61469" && write[2] === 1), true);
  assert.equal(h.cleared.at(-1)?.[0], "mal:14719", "completed episode clears only the original resume identity");
  assert.equal(h.history.at(-1)?.[0], "mal:14719", "original playback history never changes");
  h.unmount();
});

test("Refract early logging is opt-in, once per playback, and independent of Harbor completion", () => {
  const h = resumeAutosaveHarness();
  h.enableRefract(180);
  const p = playbackParams();
  h.render(p);
  // Autosave skips writes less than 1.5 seconds apart; cross the threshold on a real tick.
  h.render({ ...p, snap: { ...p.snap, status: "playing", positionSec: 178, durationSec: 3600 } });
  h.clock(178);
  h.tick();
  assert.equal(h.refractWatches.length, 0);
  h.clock(180);
  h.tick();
  assert.equal(h.refractWatches.length, 1);
  assert.equal(h.refractWatches[0][0].id, "tt100");
  assert.deepEqual(h.refractWatches[0][1].episodes, [{ season: 1, episode: 1 }]);
  assert.equal(h.watched.length, 0);
  assert.equal(h.watchEvents.length, 0);
  h.clock(3500);
  h.tick();
  assert.equal(h.refractWatches.length, 1);
  assert.equal(h.watchEvents.length, 1);
  assert.deepEqual(h.watched[0], ["tt100", 1, 1, true]);
});

test("Refract waits for verified anime identity and episode mapping", () => {
  const h = resumeAutosaveHarness();
  h.enableRefract(180);
  const p = playbackParams(1, 1, { resolvedImdbId: null, resolvedImdbVerified: false });
  p.src.meta.id = "kitsu:12";
  h.render(p);
  const playing = {
    ...p,
    snap: { ...p.snap, status: "playing", positionSec: 180, durationSec: 3600 },
  };
  h.render(playing);
  h.clock(180);
  h.tick();
  assert.equal(h.refractWatches.length, 0);
  h.render({
    ...playing,
    resolvedImdbId: "tt200",
    resolvedImdbVerified: true,
    src: { ...p.src, episode: { ...p.src.episode, imdbSeason: 2, imdbEpisode: 4 } },
  });
  h.clock(184);
  h.tick();
  assert.equal(h.refractWatches.length, 1);
  assert.equal(h.refractWatches[0][1].externalId, "tt200");
  assert.deepEqual(h.refractWatches[0][1].episodes, [{ season: 2, episode: 4 }]);
  h.clock(188);
  h.tick();
  assert.equal(h.refractWatches.length, 1);
});

test("Refract logs a viewing once across source switches and retries", () => {
  const h = resumeAutosaveHarness();
  h.enableRefract(180);
  const p = playbackParams();
  const play = (params: ReturnType<typeof playbackParams>, positionSec: number) => {
    h.render(params);
    h.render({
      ...params,
      snap: { ...params.snap, status: "playing", positionSec, durationSec: 3600 },
    });
    h.clock(positionSec);
    h.tick();
  };

  play(p, 180);
  assert.equal(h.refractWatches.length, 1);
  const switched = { ...p, src: { ...p.src, url: "https://media.test/alternate.mkv" } };
  play(switched, 2400);
  assert.equal(h.refractWatches.length, 1);
  const retried = { ...switched, src: { ...switched.src, attempt: 1 } };
  play(retried, 2500);
  h.unmount();
  assert.equal(h.refractWatches.length, 1);
  assert.equal(h.writes.at(-1)?.[1], 2500000);
});

test("Refract starts a new viewing on episode changes and a fresh player mount", () => {
  const h = resumeAutosaveHarness();
  h.enableRefract(180);
  const play = (
    harness: ReturnType<typeof resumeAutosaveHarness>,
    season: number,
    episode: number,
  ) => {
    const p = playbackParams(season, episode);
    harness.render(p);
    harness.render({
      ...p,
      snap: { ...p.snap, status: "playing", positionSec: 180, durationSec: 3600 },
    });
    harness.clock(180);
    harness.tick();
  };

  play(h, 1, 1);
  play(h, 1, 2);
  assert.deepEqual(
    h.refractWatches.map(([event]) => [event.season, event.episode]),
    [
      [1, 1],
      [1, 2],
    ],
  );
  h.unmount();
  const reopened = resumeAutosaveHarness();
  reopened.enableRefract(180);
  play(reopened, 1, 1);
  assert.equal(reopened.refractWatches.length, 1);
  assert.equal(reopened.refractWatches[0][0].episode, 1);
  reopened.unmount();
});
