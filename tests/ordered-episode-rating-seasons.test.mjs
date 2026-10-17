import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function render(episodes, layout = "grid", ratings = new Map([["3:1", 8.3]])) {
  const requests = [];
  const mocks = {
    react: { useMemo: (fn) => fn(), useSyncExternalStore: () => 0 },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "@/lib/settings": {
      useSettings: () => ({
        settings: { episodeLayout: layout, showEpisodeRating: true, omdbKey: "fixture-only" },
      }),
    },
    "@/lib/episode-progress": {
      getEpisodeProgress: () => ({ ratio: 0, watched: false, startedAt: 0 }),
    },
    "@/lib/manual-watched": {},
    "@/lib/spoilers": { spoilerMaskFor: () => ({}) },
    "../episode-grid-skeleton": { EpisodeGridSkeleton: "skeleton" },
    "../series-episode-row": { EpisodeRow: "episode-row" },
    "../episode-strip": { EpisodeStrip: "episode-strip" },
    "../use-episode-imdb-ratings": {
      useEpisodeImdbRatings: (id, seasons, key) => {
        requests.push({ id, seasons, key });
        return ratings;
      },
    },
  };
  const source = readFileSync(
    new URL("../src/views/detail/series-episodes/ordered-episodes.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const api = {};
  new Function("require", "exports", compiled)((id) => {
    assert.ok(id in mocks, id);
    return mocks[id];
  }, api);
  const tree = api.OrderedEpisodes({
    meta: { id: "tt5071412", type: "series" },
    episodes,
    loading: false,
    traktKey: "tt5071412",
    traktWatched: new Set(),
    simklWatched: new Set(),
    seriesImdbId: "tt5071412",
    onContextMenu() {},
  });
  return { tree, requests };
}

test("ordered season 3 cards request season 3 ratings instead of the hidden main season", () => {
  const episodes = [{ id: 1, seasonNumber: 3, episodeNumber: 1, voteAverage: 7 }];
  const h = render(episodes);
  assert.deepEqual(h.requests[0].seasons, [3]);
  assert.equal(h.tree.props.episodes[0].imdbRating, 8.3);
  assert.equal(episodes[0].imdbRating, undefined);
});

test("story arcs fetch every displayed canonical season, with no duplicated season requests", () => {
  const episodes = [
    { id: 1, seasonNumber: 2, episodeNumber: 1 },
    { id: 2, seasonNumber: 3, episodeNumber: 1 },
    { id: 3, seasonNumber: 2, episodeNumber: 2 },
  ];
  const h = render(
    episodes,
    "grid",
    new Map([
      ["2:1", 8],
      ["3:1", 8.3],
      ["2:2", 8.5],
    ]),
  );
  assert.deepEqual(h.requests[0].seasons, [2, 3]);
  assert.deepEqual(
    h.tree.props.episodes.map((ep) => ep.imdbRating),
    [8, 8.3, 8.5],
  );
});

test("ordered rows receive the same valid IMDb ratings without relabeling missing scores", () => {
  const h = render(
    [
      { id: 1, seasonNumber: 3, episodeNumber: 1 },
      { id: 2, seasonNumber: 3, episodeNumber: 2, voteAverage: 7 },
    ],
    "list",
  );
  assert.equal(h.tree.props.children[0].props.ep.imdbRating, 8.3);
  assert.equal(h.tree.props.children[1].props.ep.imdbRating, undefined);
});
