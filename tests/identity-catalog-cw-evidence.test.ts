import assert from "node:assert/strict";
import test from "node:test";
import { catalogCwEvidence, type CatalogEvidenceDeps } from "../src/lib/identity/catalog-cw-evidence.ts";

const series = {
  _id: "tt2359704",
  type: "series",
  name: "JoJo's Bizarre Adventure",
  isAnime: true,
  state: { season: 6, episode: 2, video_id: "tt2359704:6:2" },
};
const jojoEvidence = {
  proven: () => "kitsu:49847",
  getImdb: () => null,
  video: async () => ({
    id: "kitsu:49847:2",
    imdb_id: "tt2359704",
    imdbSeason: 6,
    imdbEpisode: 2,
  }),
} satisfies CatalogEvidenceDeps;

test("IMDb catalog checkpoints need an independent exact source/video/episode proof", async () => {
  assert.deepEqual(await catalogCwEvidence(series, jojoEvidence), {
    target: "kitsu:49847", nativeEpisode: 2,
  });
});

test("TMDB series with an independently verified IMDb alias can use the same exact proof", async () => {
  const row = {
    ...series, _id: "tmdb:tv:45790", altIds: ["tt2359704"],
    state: { ...series.state, video_id: "tt2359704:6:2" },
  };
  assert.deepEqual(await catalogCwEvidence(row, jojoEvidence), {
    target: "kitsu:49847", nativeEpisode: 2,
  });
  const viaImdbCache = {
    ...jojoEvidence,
    getImdb: (id: string) => id === "tmdb:tv:45790" ? "tt2359704" : null,
  };
  assert.deepEqual(await catalogCwEvidence({ ...row, altIds: [] }, viaImdbCache), {
    target: "kitsu:49847", nativeEpisode: 2,
  });
});

test("wrong work, mismatched provider episode, and unverified IMDb are never corrected", async () => {
  for (const source of [
    { ...jojoEvidence, proven: () => null },
    { ...jojoEvidence, proven: () => "kitsu:44294" },
    { ...jojoEvidence, video: async () => ({ ...await jojoEvidence.video(), imdb_id: "tt00000" }) },
    { ...jojoEvidence, video: async () => ({ ...await jojoEvidence.video(), imdbSeason: 5 }) },
    { ...jojoEvidence, video: async () => ({ ...await jojoEvidence.video(), imdbEpisode: 3 }) },
    { ...jojoEvidence, video: async () => ({ ...await jojoEvidence.video(), id: "kitsu:44294:2" }) },
    { ...jojoEvidence, video: async () => null },
  ]) assert.equal(await catalogCwEvidence(series, source), null);
});

test("movies, specials without valid season coordinates, and lookup failures fail closed", async () => {
  assert.equal(await catalogCwEvidence({ ...series, type: "movie" }, jojoEvidence), null);
  assert.equal(await catalogCwEvidence({
    ...series, state: { ...series.state, season: 0 },
  }, jojoEvidence), null);
  assert.equal(await catalogCwEvidence(series, {
    ...jojoEvidence, video: async () => { throw Error("offline"); },
  }), null);
});
