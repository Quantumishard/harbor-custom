import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness(initialKey = "rfk_original_fixture") {
  let key = initialKey;
  let finish;
  const metadata = new Promise((resolve) => {
    finish = resolve;
  });
  const local = [];
  const refract = [];
  const noop = () => {};
  const mocks = {
    "@/lib/cinemeta": { meta: () => metadata, narrowMediaType: (type) => type },
    "@/lib/playback-history": { savePlayback: noop },
    "@/lib/trakt/history": { pushWatched: noop },
    "@/lib/trakt/resolve": { markEpisodeWatched: noop },
    "@/lib/trakt/ids": { stremioIdToTraktTarget: () => ({ ok: false }) },
    "@/lib/trakt/session": { getSession: () => null },
    "@/lib/active-profile-id": {
      activeProfileId: () => "fixture",
      isNuvioProviderActive: () => false,
    },
    "@/lib/simkl/history": { addToHistory: noop },
    "@/lib/publicmetadb/history": { markPmdbWatched: noop, unmarkPmdbWatched: noop },
    "@/lib/publicmetadb/ids": { stremioIdToPmdbTarget: () => null },
    "@/lib/movie-watched": { setMovieWatchedLocal: noop },
    "@/lib/manual-watched": {
      recordManualWatchedMeta: noop,
      setManualWatchedMany: (...args) => local.push(args),
    },
    "@/lib/watched-flag": { setWatchedFlag: noop },
    "@/lib/watch-events": {
      recordWatchEvent: noop,
      recordRefractWatch: (...args) => refract.push({ key, args }),
    },
    "@/lib/refract/client": { getRefractKey: () => key },
    "@/lib/auth": { readActiveStremioAuthKey: () => null },
    "@/lib/stremio": { cloudWriteId: () => null },
    "@/lib/stremio-watched-sync": { markMovieWatchedStremio: noop },
    "@/lib/stremio-episode-watched": { syncSeriesWatchedToStremio: noop },
    "@/lib/providers/tmdb/tmdb-imdb-resolve": { tmdbImdbCached: () => null },
    "@/lib/aired": { airedOnly: (rows) => rows },
    "@/lib/nuvio/nuvio-client": { isNuvioSignedIn: () => false },
    "@/lib/nuvio/nuvio-sync": {},
  };
  const source = readFileSync(new URL("../src/lib/mark-watched.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => {
      assert.ok(name in mocks, `Unexpected import: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
  );
  return {
    mark: () => module.exports.markMetaWatched({ id: "tt100", type: "series", name: "Fixture" }),
    release: () => finish({ videos: [{ season: 1, episode: 1, released: "2020-01-01" }] }),
    setKey: (value) => {
      key = value;
    },
    local,
    refract,
  };
}

test("bulk watched lookup skips Refract after an account replacement, preserving Harbor state", async () => {
  const h = harness();
  const marking = h.mark();
  h.setKey("rfk_replacement_fixture");
  h.release();
  await marking;
  assert.deepEqual(h.refract, []);
  assert.deepEqual(h.local, [["tt100", [{ season: 1, episode: 1 }], true]]);
});

test("bulk watched lookup cannot send to an account connected after the action began", async () => {
  const h = harness(null);
  const marking = h.mark();
  h.setKey("rfk_replacement_fixture");
  h.release();
  await marking;
  assert.equal(h.refract.length, 0);
  assert.equal(h.local.length, 1);
});

test("bulk watched lookup sends episodes when the original Refract account remains connected", async () => {
  const h = harness();
  const marking = h.mark();
  h.release();
  await marking;
  assert.equal(h.refract.length, 1);
  assert.equal(h.refract[0].key, "rfk_original_fixture");
  assert.deepEqual(h.refract[0].args[1].episodes, [{ season: 1, episode: 1 }]);
  assert.equal(h.local.length, 1);
});
