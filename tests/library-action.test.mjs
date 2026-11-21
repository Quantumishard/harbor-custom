import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

function load(overrides = {}, local = storage()) {
  const calls = {
    watchlist: [],
    aniSave: [],
    aniDelete: [],
    malSave: [],
    malDelete: [],
    refreshes: [],
  };
  const state = {
    profile: "one",
    aniConnected: false,
    malConnected: false,
    aniEntry: null,
    malEntry: null,
    base: { outcomes: [{ provider: "Harbor", status: "updated" }] },
  };
  const defaults = {
    react: { useSyncExternalStore: () => "library" },
    "./active-profile-id": { activeScopedProfileId: () => state.profile },
    "./watchlist": { clearWatchlistAggregate: () => {} },
    "./tracker-status-events": {
      notifyTrackerStatusChanged: () =>
        calls.refreshes.push({ aniSaves: calls.aniSave.length, malSaves: calls.malSave.length }),
    },
    "./media-context-actions": {
      setContextWatchlist: async (input, on, policy) => {
        calls.watchlist.push({ input, on, policy });
        return state.base;
      },
    },
    "./anilist/session": { isAuthenticated: () => state.aniConnected },
    "./anilist/sync": { resolveAnilistMediaId: async () => 42 },
    "./anilist/mutations": {
      fetchListEntry: async () => ({ entry: state.aniEntry }),
      saveListEntry: async (entry) => {
        calls.aniSave.push(entry);
        return { id: 1, status: entry.status };
      },
      deleteListEntry: async (id) => {
        calls.aniDelete.push(id);
        return true;
      },
    },
    "./mal/session": { isAuthenticated: () => state.malConnected },
    "./mal/mutations": {
      resolveMalMediaId: async () => 7,
      fetchListEntry: async () => ({ entry: state.malEntry }),
      saveListEntry: async (entry) => {
        calls.malSave.push(entry);
        return { status: entry.status, numEpisodesWatched: 0 };
      },
      deleteListEntry: async (id) => {
        calls.malDelete.push(id);
        return true;
      },
    },
  };
  const mocks = { ...defaults, ...overrides };
  const code = ts.transpileModule(read("src/lib/library-action.ts"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "localStorage", code)((id) => mocks[id] ?? {}, exports, local);
  return { mod: exports, calls, state, local };
}

const anime = { id: "tt1", type: "anime", name: "Anime", animeId: "mal:1" };

test("library scope keeps the current save path and skips anime extras", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.malConnected = true;
  const result = await f.mod.setLibraryMembership(anime, true, "library");
  assert.equal(f.calls.watchlist.length, 1);
  assert.equal(f.calls.watchlist[0].on, true);
  assert.equal(f.calls.watchlist[0].policy, "skip");
  assert.deepEqual(f.calls.aniSave, []);
  assert.deepEqual(f.calls.malSave, []);
  assert.equal(result.scope, "library");
  assert.deepEqual(f.calls.refreshes, []);
});

test("all scope refreshes tracker buttons after adding to connected trackers", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.malConnected = true;
  f.state.base.outcomes.push({ provider: "Simkl", status: "updated" });
  const result = await f.mod.setLibraryMembership(anime, true, "all");
  assert.deepEqual(f.calls.aniSave, [{ mediaId: 42, status: "PLANNING" }]);
  assert.deepEqual(f.calls.malSave, [{ malId: 7, status: "plan_to_watch" }]);
  assert.ok(result.outcomes.some((o) => o.provider === "AniList" && o.status === "updated"));
  assert.ok(result.outcomes.some((o) => o.provider === "MyAnimeList" && o.status === "updated"));
  assert.deepEqual(f.calls.refreshes, [{ aniSaves: 1, malSaves: 1 }]);
});

test("a successful Simkl update refreshes tracker buttons despite another tracker failing", async () => {
  const f = load();
  f.state.base.outcomes.push(
    { provider: "Simkl", status: "updated" },
    { provider: "PMDB", status: "failed" },
  );
  await f.mod.setLibraryMembership({ id: "tt2", type: "movie", name: "Movie" }, true, "all");
  assert.deepEqual(f.calls.refreshes, [{ aniSaves: 0, malSaves: 0 }]);
});

test("all scope never downgrades an existing anime status", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.malConnected = true;
  f.state.aniEntry = { id: 9, status: "COMPLETED" };
  f.state.malEntry = { status: "completed" };
  const result = await f.mod.setLibraryMembership(anime, true, "all");
  assert.deepEqual(f.calls.aniSave, []);
  assert.deepEqual(f.calls.malSave, []);
  assert.ok(
    result.outcomes.some(
      (o) => o.provider === "AniList" && o.status === "unsupported" && /already/i.test(o.reason),
    ),
  );
});

test("all scope removes existing anime list entries", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.malConnected = true;
  f.state.aniEntry = { id: 9, status: "COMPLETED" };
  f.state.malEntry = { status: "completed" };
  const result = await f.mod.setLibraryMembership(anime, false, "all");
  assert.deepEqual(f.calls.aniDelete, [9]);
  assert.deepEqual(f.calls.malDelete, [7]);
  assert.equal(f.calls.refreshes.length, 1);
  assert.ok(result.outcomes.some((o) => o.provider === "AniList" && o.status === "updated"));
  assert.ok(result.outcomes.some((o) => o.provider === "MyAnimeList" && o.status === "updated"));
});

test("non-anime all scope does not touch anime trackers", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.malConnected = true;
  await f.mod.setLibraryMembership({ id: "tt2", type: "movie", name: "Movie" }, true, "all");
  assert.deepEqual(f.calls.aniSave, []);
  assert.deepEqual(f.calls.malSave, []);
});

test("a failed local write prevents anime extras", async () => {
  const f = load();
  f.state.aniConnected = true;
  f.state.base = { outcomes: [{ provider: "Harbor", status: "failed" }] };
  await f.mod.setLibraryMembership(anime, true, "all");
  assert.deepEqual(f.calls.aniSave, []);
});

test("the remembered scope is per profile", () => {
  const f = load();
  f.mod.setLibraryAddScope("all");
  assert.equal(f.mod.readLibraryAddScope(), "all");
  f.state.profile = "two";
  assert.equal(f.mod.readLibraryAddScope(), "library");
  f.mod.setLibraryAddScope("all");
  f.state.profile = "one";
  assert.equal(f.mod.readLibraryAddScope(), "all");
});
