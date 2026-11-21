import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function load(path, mocks = {}) {
  const code = ts.transpileModule(read(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((id) => mocks[id] ?? {}, exports);
  return exports;
}

const local = (id, imdbId, type = "movie") => ({
  id,
  imdbId,
  type,
  name: "Fixture",
  addedAt: 1,
});

const movie = (state = {}) => ({
  _id: "tt1",
  type: "movie",
  name: "Fixture",
  removed: false,
  temp: false,
  _ctime: "2026-01-01T00:00:00Z",
  _mtime: "2026-01-02T00:00:00Z",
  state: {
    duration: 100,
    timeOffset: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    ...state,
  },
});

const series = (state = {}) => ({
  ...movie(state),
  _id: "tt2",
  type: "series",
  state: { duration: 100, timeOffset: 0, timesWatched: 0, flaggedWatched: 0, ...state },
});

function view(mocks = {}) {
  return load("src/lib/watchlist-watched.ts", {
    "./stremio": { CW_FINISHED_RATIO: 0.9 },
    "./movie-watched": { isMovieWatchedLocal: () => false },
    "./watched-flag": { isWatchedFlagged: () => false },
    ...mocks,
  });
}

test("an in-progress movie is not finished, a completed movie is", () => {
  const v = view();
  assert.deepEqual(v.collectStremioFinishedIds([movie({ timeOffset: 50 })]), new Set());
  assert.deepEqual(v.collectStremioFinishedIds([movie({ timeOffset: 95 })]), new Set(["tt1"]));
  assert.deepEqual(v.collectStremioFinishedIds([movie({ timesWatched: 1 })]), new Set(["tt1"]));
});

test("series are not finished just because one video was watched", () => {
  const v = view();
  assert.deepEqual(v.collectStremioFinishedIds([series({ timesWatched: 3 })]), new Set());
});

test("watched local movies are filtered from Watchlist", () => {
  const v = view({
    "./movie-watched": { isMovieWatchedLocal: (id) => id === "tmdb:movie:1" },
  });
  const entry = local("tmdb:movie:1", "tt1");
  const card = { meta: { id: "tmdb:movie:1", type: "movie" }, localId: "tmdb:movie:1" };
  assert.equal(v.isMergedWatchlistCardFinished(card, [entry], new Set(), new Set()), true);
});

test("lazy finished series are filtered from Watchlist", () => {
  const v = view();
  const card = { meta: { id: "tt2", type: "series" }, stremioId: "tt2" };
  assert.equal(v.isMergedWatchlistCardFinished(card, [], new Set(), new Set(["tt2"])), true);
  assert.equal(v.isMergedWatchlistCardFinished(card, [], new Set(), new Set()), false);
});

test("series whole-show watched flags are honoured synchronously", () => {
  const v = view({ "./watched-flag": { isWatchedFlagged: (id) => id === "tt2" } });
  const card = { meta: { id: "tt2", type: "series" }, stremioId: "tt2" };
  assert.equal(v.isMergedWatchlistCardFinished(card, [], new Set(), new Set()), true);
});

test("in-progress movies are not in History; finished movies are", () => {
  const history = load("src/views/library/history-merge.ts", {
    "@/lib/stremio": {
      CW_FINISHED_RATIO: 0.9,
      episodeFromVideoId: () => null,
      libraryMetaType: (type) => type,
    },
    "./shared": { parseTs: (value) => (value ? Date.parse(value) : null) },
  });
  assert.equal(history.filterHistory([movie({ timeOffset: 50 })]).length, 0);
  assert.equal(history.filterHistory([movie({ timeOffset: 95 })]).length, 1);
  assert.equal(history.filterHistory([movie({ timesWatched: 1 })]).length, 1);
});

function simklFixture(state) {
  const calls = [];
  const watchlist = load("src/lib/simkl/watchlist.ts", {
    "./activities/gate": { currentActivitiesAll: async () => null },
    "./client": {
      simklRequest: async (path, options) => {
        calls.push({ path, options });
        return { added: { movies: [{ to: "plantowatch" }] } };
      },
    },
    "./ids": { simklTargetIds: () => ({ imdb: "tt1" }) },
    "./list-status": { readSimklStateStrict: async () => state },
  });
  return { watchlist, calls };
}

test("Simkl completed titles are never removed through the watchlist path", async () => {
  const f = simklFixture({ status: "completed", watched: new Set(["movie"]) });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    false,
  );
  assert.equal(f.calls.length, 0);
});

test("Simkl plan-to-watch with no history can be removed", async () => {
  const f = simklFixture({ status: "plantowatch", watched: new Set() });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    true,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/sync/history/remove");
});

test("Simkl plan-to-watch with history is left untouched", async () => {
  const f = simklFixture({ status: "plantowatch", watched: new Set(["movie"]) });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    false,
  );
  assert.equal(f.calls.length, 0);
});
