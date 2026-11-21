import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

function load(relative, mocks) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => {
      assert.ok(name in mocks, `Unexpected dependency ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

function provider(request) {
  return load("../src/lib/providers/trakt-related.ts", {
    react: React,
    "@/lib/maintenance": { registerEvictable() {} },
    "@/lib/trakt/client": { traktRequest: request },
  });
}

const movie = (id, title = id) => ({ title, ids: { imdb: id }, year: 2000 });

test("Trakt uses public title-specific requests, removes self and duplicates, and caches by title/type", async () => {
  const calls = [];
  const api = provider(async (path, options) => {
    calls.push({ path, options });
    return [movie("tt1"), movie("tt2"), movie("tt2"), movie("invalid"), movie("tt3", "")];
  });
  const first = await api.traktRelated("movie", "tt1");
  assert.deepEqual(
    first.map((m) => m.id),
    ["tt2"],
  );
  assert.equal(first[0].type, "movie");
  assert.equal(calls[0].path, "/movies/tt1/related?extended=full&limit=20");
  assert.deepEqual(calls[0].options, { authed: false });
  await api.traktRelated("movie", "tt1");
  assert.equal(calls.length, 1);
  const shows = await api.traktRelated("show", "tt1");
  assert.equal(shows[0].type, "series");
  assert.match(calls[1].path, /^\/shows\//);
  await api.traktRelated("movie", "tt9");
  assert.equal(calls.length, 3);
  assert.deepEqual(await api.traktRelated("movie", "tt1:1:1"), []);
  assert.equal(calls.length, 3);
});

test("concurrent requests share one fetch and a failed fetch can retry", async () => {
  let resolve;
  let calls = 0;
  const api = provider(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const a = api.traktRelated("movie", "tt1");
  const b = api.traktRelated("movie", "tt1");
  resolve([movie("tt2")]);
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  let attempts = 0;
  const retry = provider(async () => {
    if (++attempts === 1) throw new Error("offline");
    return [movie("tt2")];
  });
  assert.deepEqual(await retry.traktRelated("movie", "tt1"), []);
  assert.equal((await retry.traktRelated("movie", "tt1")).length, 1);
});

test("source selection prefers Trakt, falls back to TMDB, and preserves anime recommendations", () => {
  let related = [{ id: "tt2", type: "movie", name: "Trakt pick" }];
  const hook = load("../src/lib/use-more-like-this.ts", {
    react: { useMemo: (fn) => fn() },
    "./providers/trakt-related": { useTraktRelated: () => related },
  });
  const meta = { id: "tmdb:movie:1", type: "movie", name: "Seed" };
  const fallback = [meta, { id: "tt3", type: "movie", name: "TMDB pick" }];
  const detail = { id: 1, kind: "movie", imdbId: "tt1", recommendations: fallback };
  assert.equal(hook.useMoreLikeThis(meta, detail)[0].name, "Trakt pick");
  related = [];
  assert.deepEqual(
    hook.useMoreLikeThis(meta, detail).map((m) => m.id),
    ["tt3"],
  );
  related = [{ id: "tt2", type: "movie", name: "Trakt pick" }];
  assert.equal(hook.useMoreLikeThis(meta, detail, false), fallback);
});

test("switching titles immediately hides old results and rejects a late response", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pending = new Map();
  const api = provider((path) => new Promise((done) => pending.set(path.match(/tt\d+/)[0], done)));
  const renders = [];
  function Probe({ id }) {
    const rows = api.useTraktRelated(id, "movie");
    renders.push({ id, names: rows.map((m) => m.name) });
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await React.act(() => root.render(React.createElement(Probe, { id: "tt1" })));
    await React.act(async () => pending.get("tt1")([movie("tt10", "Old pick")]));
    assert.deepEqual(renders.at(-1).names, ["Old pick"]);
    await React.act(() => root.render(React.createElement(Probe, { id: "tt2" })));
    assert.ok(renders.filter((r) => r.id === "tt2").every((r) => r.names.length === 0));
    await React.act(() => root.render(React.createElement(Probe, { id: "tt3" })));
    await React.act(async () => pending.get("tt2")([movie("tt20", "Late pick")]));
    assert.deepEqual(renders.at(-1).names, []);
    await React.act(async () => pending.get("tt3")([movie("tt30", "Current pick")]));
    assert.deepEqual(renders.at(-1).names, ["Current pick"]);
    await React.act(() => root.render(React.createElement(Probe, { id: null })));
    assert.deepEqual(renders.at(-1).names, []);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("a new page cannot use metadata still belonging to the previous film", () => {
  const seeds = [];
  const hook = load("../src/lib/use-more-like-this.ts", {
    react: { useMemo: (fn) => fn() },
    "./providers/trakt-related": {
      useTraktRelated: (seed) => {
        seeds.push(seed);
        return [];
      },
    },
  });
  const old = { id: 1, kind: "movie", imdbId: "tt1", recommendations: [{ id: "tt9" }] };
  assert.deepEqual(hook.useMoreLikeThis({ id: "tt2", type: "movie" }, old), []);
  assert.equal(seeds.at(-1), "tt2");
  assert.deepEqual(hook.useMoreLikeThis({ id: "tmdb:movie:2", type: "movie" }, old), []);
  assert.equal(seeds.at(-1), null);
  assert.deepEqual(hook.useMoreLikeThis({ id: "tmdb:2", type: "movie" }, old), []);
  assert.equal(seeds.at(-1), null);
});

test("end screen uses Trakt before loading metadata and falls back when unavailable", async () => {
  let related = [{ id: "tt2", type: "movie", name: "Trakt pick" }];
  let details = 0;
  const api = load("../src/lib/recommendations.ts", {
    "@/lib/providers/cinemeta-details": { cinemetaDetails: async () => null },
    "@/lib/providers/tmdb/tmdb-details": {
      tmdbDetails: async () => {
        details++;
        return {
          id: 1,
          kind: "movie",
          imdbId: "tt1",
          recommendations: [{ id: "tt3" }],
          similar: [],
        };
      },
    },
    "@/lib/providers/anime-recommendations": {
      animeRecommendations: async () => [{ id: "kitsu:2" }],
    },
    "@/lib/providers/kitsu": { parseKitsuId: (id) => (id.startsWith("kitsu:") ? 1 : null) },
    "@/lib/providers/trakt-related": { traktRelated: async () => related },
  });
  assert.equal((await api.loadMoreLikeThis({ id: "tt1", type: "movie" }, "key"))[0].id, "tt2");
  assert.equal(details, 0);
  related = [];
  assert.equal((await api.loadMoreLikeThis({ id: "tt1", type: "movie" }, "key"))[0].id, "tt3");
  related = [{ id: "tt2" }];
  assert.equal(
    (await api.loadMoreLikeThis({ id: "tmdb:movie:1", type: "movie" }, "key"))[0].id,
    "tt2",
  );
  assert.equal(
    (await api.loadMoreLikeThis({ id: "kitsu:1", type: "series" }, "key"))[0].id,
    "kitsu:2",
  );
});
