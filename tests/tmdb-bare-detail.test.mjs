import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness(raw, lookup = null) {
  const calls = [];
  const mocks = {
    "./movie-release-dates": { movieReleaseDates: () => [] },
    "./tmdb-client": {
      IMG: "https://image.tmdb.org/t/p",
      effectiveTmdbLanguage: () => "en",
      get: async (_key, path) => {
        calls.push(path);
        return path.startsWith("find/") ? lookup : raw;
      },
    },
    "./tmdb-image-rungs": {
      tmdbPosterUrl: (path) => (path ? `poster:${path}` : undefined),
      tmdbBackdropUrl: (path) => path,
    },
    "@/lib/settings/load": {
      loadStoredSettings: () => ({
        translateTitles: true,
        translateDescriptions: true,
        region: "US",
      }),
    },
    "./tmdb-images": { pickLogo: () => undefined, fetchMovieAssets: async () => null },
    "./tmdb-image-lang": { imageLangParam: () => "en,null", imageLangRank: () => 0 },
    "./tmdb-trailers": { pickTrailers: () => [] },
    "./tmdb-meta-mappers": { isAnimeItem: () => false },
    "./tmdb-title-fallback": {
      pickTmdbTitle: (entry) => entry.localized,
      shouldUseEnglishTitle: () => false,
      tmdbEnglishTranslation: () => null,
      tmdbEnglishTitle: () => undefined,
    },
    "@/lib/storage-recovery": { setItemWithRecovery() {} },
    "@/lib/episode-text-language": { episodeTextLanguage: () => "en" },
    "@/lib/season-name": { isGenericSeasonName: () => false },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/lib/providers/tmdb/tmdb-details.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api = {};
  new Function("require", "exports", "localStorage", "setTimeout", code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    api,
    { getItem: () => null },
    () => 1,
  );
  return { calls, load: (meta, key = "test-key") => api.tmdbDetails(key, meta) };
}

const film = {
  id: 1588457,
  title: "Carrizos",
  original_title: "Carrizos",
  original_language: "en",
  release_date: "2025-01-01",
  runtime: 9,
  genres: [{ id: 99, name: "Documentary" }],
  overview: "Documentary overview",
  credits: { crew: [{ id: 7, name: "Director", job: "Director" }] },
  external_ids: { imdb_id: null },
  poster_path: "/poster.jpg",
};

test("bare addon movie IDs load full TMDB metadata without an IMDb entry", async () => {
  const h = harness(film);
  const meta = {
    id: "tmdb:1588457",
    type: "movie",
    name: "Carrizos",
    addonOrigin: { id: "aio-metadata", name: "AIOMetadata" },
  };
  const before = structuredClone(meta);
  const detail = await h.load(meta);
  assert.deepEqual(h.calls, ["movie/1588457"]);
  assert.equal(detail.title, "Carrizos");
  assert.equal(detail.runtime, "9 min");
  assert.deepEqual(detail.genres, ["Documentary"]);
  assert.deepEqual(detail.directors, [{ id: 7, name: "Director" }]);
  assert.equal(detail.imdbId, null);
  assert.deepEqual(meta, before);
});

test("bare addon series IDs use the TV endpoint and retain season metadata", async () => {
  const h = harness({
    id: 27146,
    name: "Metropolis",
    original_language: "en",
    external_ids: { imdb_id: null },
    number_of_seasons: 1,
    number_of_episodes: 6,
    seasons: [{ id: 1, season_number: 1, name: "Season 1", episode_count: 6 }],
  });
  const detail = await h.load({ id: "tmdb:27146", type: "series", name: "Metropolis" });
  assert.deepEqual(h.calls, ["tv/27146"]);
  assert.equal(detail.kind, "tv");
  assert.equal(detail.tmdbTvId, 27146);
  assert.equal(detail.seasons[0].episodeCount, 6);
  assert.equal(detail.numberOfEpisodes, 6);
});

test("the same bare numeric ID is resolved using its declared media type", async () => {
  for (const [type, expected] of [
    ["movie", "movie"],
    ["series", "tv"],
  ]) {
    const h = harness(film);
    await h.load({ id: "tmdb:123", type, name: "Title" });
    assert.deepEqual(h.calls, [`${expected}/123`]);
  }
});

test("existing scoped TMDB and IMDb IDs retain their resolution behavior", async () => {
  for (const [id, type, expected] of [
    ["tmdb:movie:1588457", "movie", "movie/1588457"],
    ["tmdb:tv:27146", "series", "tv/27146"],
    ["tmdb:movie:1588457", "series", "movie/1588457"],
  ]) {
    const h = harness(film);
    assert.ok(await h.load({ id, type, name: "Title" }));
    assert.deepEqual(h.calls, [expected]);
  }
  const h = harness(film, { movie_results: [{ id: 1588457 }] });
  assert.ok(await h.load({ id: "tt1234567", type: "movie", name: "Title" }));
  assert.deepEqual(h.calls, ["find/tt1234567", "movie/1588457"]);
});

test("malformed IDs, ambiguous media types, missing keys and absent records fail safely", async () => {
  for (const [id, type] of [
    ["tmdb:abc", "movie"],
    ["tmdb:123:1:2", "series"],
    ["tmdb:-1", "movie"],
    ["tmdb:123", "other"],
    ["tmdb:123", "anime"],
  ]) {
    const h = harness(film);
    assert.equal(await h.load({ id, type, name: "Title" }), null);
    assert.deepEqual(h.calls, []);
  }
  const missingKey = harness(film);
  assert.equal(await missingKey.load({ id: "tmdb:123", type: "movie", name: "Title" }, ""), null);
  assert.deepEqual(missingKey.calls, []);
  const missing = harness(null);
  assert.equal(await missing.load({ id: "tmdb:123", type: "movie", name: "Title" }), null);
});
