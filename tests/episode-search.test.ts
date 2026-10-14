// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  episodeSearchVideos,
  matchingEpisodeVideos,
  specificEpisodeTitle,
} from "../src/lib/episode-search";

const trumpEpisode = {
  id: 4301,
  seasonNumber: 43,
  episodeNumber: 1,
  name: "Trump's Comeback",
  overview: "A report on the election.",
  stillPath: null,
  airDate: "2025-01-01",
  runtime: 60,
  voteAverage: null,
};

test("search finds the displayed TMDB episode without Cinemeta videos", () => {
  const videos = episodeSearchVideos(undefined, [], [trumpEpisode]);
  assert.deepEqual(
    matchingEpisodeVideos(videos, "trump").map((video) => video.name),
    ["Trump's Comeback"],
  );
});

test("generic numbered labels do not hide a real episode title", () => {
  assert.equal(specificEpisodeTitle("Episode 01", 1), undefined);
  assert.equal(specificEpisodeTitle("The Pilot", 1), "The Pilot");
});

test("search includes fetched seasons and episode descriptions", () => {
  const videos = episodeSearchVideos(
    undefined,
    [
      {
        ...trumpEpisode,
        seasonNumber: 12,
        episodeNumber: 3,
        name: "A Different Title",
        overview: "Trump's first campaign.",
      },
    ],
    [trumpEpisode],
  );
  assert.deepEqual(
    matchingEpisodeVideos(videos, "trump").map((video) => `${video.season}:${video.episode}`),
    ["12:3", "43:1"],
  );
});

test("displayed title takes priority over an older Cinemeta title", () => {
  const videos = episodeSearchVideos(
    [{ id: "tt123:43:1", season: 43, episode: 1, name: "Episode 1" }],
    [],
    [trumpEpisode],
  );
  assert.equal(videos[0]?.name, "Trump's Comeback");
  assert.equal(videos[0]?.id, "tt123:43:1");
});
