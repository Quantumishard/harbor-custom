// One coordinate policy for Continue Watching display and provider clearing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveEpisode } from "../src/lib/cw-dismiss.ts";
import { resolvedEpisodeCoords, type LibraryItem } from "../src/lib/stremio.ts";

const item = (id: string, state: Partial<NonNullable<LibraryItem["state"]>>): LibraryItem =>
  ({ _id: id, type: "series", state }) as LibraryItem;

test("complete state coordinates win over the video id", () => {
  const card = item("tt0434665", { season: 4, episode: 11, video_id: "tt0434665:1:2" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 4, episode: 11 });
});

test("season-zero Specials keep their valid coordinates", () => {
  const card = item("tt0434665", { season: 0, episode: 5, video_id: "tt0434665:4:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 0, episode: 5 });
});

test("a removed watched-sync 0:0 placeholder uses its own S6 E7 video checkpoint", () => {
  const card = {
    ...item("tt2359704", {
      season: 0,
      episode: 0,
      video_id: "tt2359704:6:7",
      flaggedWatched: 1,
      timeOffset: 1_496_078,
      duration: 1_504_171,
    }),
    removed: true,
    temp: true,
  };
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 6, episode: 7 });
});

test("a real 0:0 Special is preserved, even when its video id disagrees", () => {
  const card = item("tt2359704", {
    season: 0,
    episode: 0,
    video_id: "tt2359704:6:7",
  });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 0, episode: 0 });
  assert.deepEqual(
    resolvedEpisodeCoords({ ...card, removed: true, temp: true, state: { ...card.state!, video_id: "tt2359704:0:0" } }),
    { season: 0, episode: 0 },
  );
});

test("a zero placeholder cannot trust another content id or a malformed video id", () => {
  const card = { ...item("tt2359704", { season: 0, episode: 0 }), removed: true, temp: true };
  assert.deepEqual(
    resolvedEpisodeCoords({ ...card, state: { ...card.state!, video_id: "tt38268282:6:7" } }),
    { season: 0, episode: 0 },
  );
  assert.deepEqual(
    resolvedEpisodeCoords({ ...card, state: { ...card.state!, video_id: "tt2359704:not-an-episode" } }),
    { season: 0, episode: 0 },
  );
});

test("a native anime stream resolves to season one", () => {
  const card = item("tt0434665", { video_id: "kitsu:49444:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 1, episode: 11 });
});

test("a native anime stream with no episode invents nothing", () => {
  const card = item("kitsu:49444", { video_id: "kitsu:49444:0" });
  assert.equal(resolvedEpisodeCoords(card), null);
});

test("incomplete state falls back to the provider video id", () => {
  const card = item("tt0434665", { season: 2, video_id: "tt0434665:3:7" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 3, episode: 7 });
});

test("a native anime card with a provider video id uses the provider coordinates", () => {
  const card = item("kitsu:49444", { video_id: "tt0434665:4:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 4, episode: 11 });
});

test("no complete coordinates resolve to null", () => {
  assert.equal(resolvedEpisodeCoords(item("tt0434665", { video_id: "tt0434665" })), null);
});

test("dismissal matching keeps its intentional partial coordinates", () => {
  const card = item("kitsu:1", { season: 2, video_id: "kitsu:1:3:7" });
  assert.deepEqual(resolveEpisode(card), { season: 2, episode: 7 });
});

test("the card and provider paths share the coordinate helper", () => {
  const advance = readFileSync("src/views/home/hooks/use-cw-advance.ts", "utf8");
  const provider = readFileSync("src/lib/cw-provider-dismiss.ts", "utf8");
  assert.match(advance, /return resolvedEpisodeCoords\(i\);/);
  assert.match(provider, /return resolvedEpisodeCoords\(item\);/);
});

test("a merged Rings of Power library placeholder may use a corroborating local S3E1 checkpoint", () => {
  const id = "tt7631058";
  const library = {
    ...item(id, {
      season: 0, episode: 0, video_id: `${id}:3:1`,
      timeOffset: 4_410_208, duration: 4_413_504, flaggedWatched: 1,
    }),
    removed: false, temp: false,
  };
  const local = {
    ...item(id, {
      season: 3, episode: 1, video_id: `${id}:3:1`,
      timeOffset: 4_410_208, duration: 4_413_504, flaggedWatched: 1,
    }),
    local: true,
  };
  assert.deepEqual(resolvedEpisodeCoords({ ...library, cwMembers: [library, local] }),
    { season: 3, episode: 1 },
    "the actual played episode must be used for CW advancement");
  assert.deepEqual(resolvedEpisodeCoords(library), { season: 0, episode: 0 },
    "without independent local proof, 0:0 must retain its existing meaning");
  assert.deepEqual(resolvedEpisodeCoords({
    ...library, cwMembers: [library, {
      ...local, _id: "tt9999999",
    }],
  }), { season: 0, episode: 0 }, "unrelated titles cannot supply playback identity");
  assert.deepEqual(resolvedEpisodeCoords({
    ...library, cwMembers: [library, {
      ...local, state: { ...local.state!, video_id: `${id}:3:2` },
    }],
  }), { season: 0, episode: 0 }, "different episode checkpoint cannot corroborate the library row");
});
