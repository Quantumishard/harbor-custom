import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const storage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
};

function load(mocks = {}, local = storage()) {
  const defaults = {
    "./aired": { airedOnly: (items) => items },
    "./active-profile-id": { activeScopedProfileId: () => "fixture" },
    "./cinemeta": { meta: async () => null },
    "./manual-watched": {
      createManualWatchedReader: () => () => undefined,
      manualWatchedRawKeys: () => [],
    },
    "./stremio-watched": { decodeWatchedEpisodes: async () => new Set() },
    "./watched-flag": { isWatchedFlagged: () => false },
  };
  const merged = { ...defaults, ...mocks };
  const code = ts.transpileModule(read("src/lib/watchlist-series-finished.ts"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "localStorage", code)(
    (id) => merged[id] ?? {},
    exports,
    local,
  );
  return exports;
}

const videos = [
  { id: "tt1:1:1", season: 1, episode: 1, released: "2020-01-01" },
  { id: "tt1:1:2", season: 1, episode: 2, released: "2020-01-02" },
];

const candidate = (overrides = {}) => ({
  id: "tt1",
  imdbId: "tt1",
  type: "series",
  videos,
  ...overrides,
});

const fromBitfield = { _id: "tt1", type: "series", state: { watched: "fixture" } };

test("all released episodes watched via the Stremio bitfield is finished", async () => {
  const mod = load({
    "./stremio-watched": {
      decodeWatchedEpisodes: async () => new Set(["1:1", "1:2"]),
    },
  });
  assert.equal(await mod.isSeriesFinished(candidate({ stremio: fromBitfield })), true);
});

test("a partially watched series is not finished", async () => {
  const mod = load({
    "./stremio-watched": {
      decodeWatchedEpisodes: async () => new Set(["1:1"]),
    },
  });
  assert.equal(await mod.isSeriesFinished(candidate({ stremio: fromBitfield })), false);
});

test("manual watched episodes count toward completion", async () => {
  const mod = load({
    "./manual-watched": {
      createManualWatchedReader: () => (id, season) =>
        id === "tt1" && season === 1 ? true : undefined,
      manualWatchedRawKeys: () => ["tt1|1|1", "tt1|1|2"],
    },
  });
  assert.equal(await mod.isSeriesFinished(candidate()), true);
});

test("an explicit local unwatch keeps the series unfinished", async () => {
  const mod = load({
    "./stremio-watched": {
      decodeWatchedEpisodes: async () => new Set(["1:1", "1:2"]),
    },
    "./manual-watched": {
      createManualWatchedReader: () => (id, season, episode) =>
        id === "tt1" && season === 1 && episode === 2 ? false : undefined,
      manualWatchedRawKeys: () => [],
    },
  });
  assert.equal(await mod.isSeriesFinished(candidate()), false);
});

test("missing videos leaves the result unknown", async () => {
  const mod = load({
    "./cinemeta": { meta: async () => ({ videos: [] }) },
  });
  assert.equal(await mod.isSeriesFinished(candidate({ videos: undefined })), null);
});

test("a whole-series watched flag finishes immediately", async () => {
  const mod = load({
    "./watched-flag": { isWatchedFlagged: (id) => id === "tt1" },
  });
  assert.equal(await mod.isSeriesFinished(candidate({ videos: undefined })), true);
});

test("the second check uses the persistent cache", async () => {
  let decodes = 0;
  const local = storage();
  const mod = load(
    {
      "./cinemeta": { meta: async () => ({ videos }) },
      "./stremio-watched": {
        decodeWatchedEpisodes: async () => {
          decodes++;
          return new Set(["1:1"]);
        },
      },
    },
    local,
  );
  const input = candidate({ videos: undefined, stremio: fromBitfield });
  assert.equal(await mod.isSeriesFinished(input), false);
  assert.equal(await mod.isSeriesFinished(input), false);
  assert.equal(decodes, 1);
});
