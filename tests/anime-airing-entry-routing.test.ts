// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

function load(file: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((id: string) => {
    assert.ok(id in mocks, `unexpected dependency ${id}`);
    return mocks[id];
  }, exports);
  return exports;
}

test("opening a second-season MAL entry uses its own AniList ID, not stale Kitsu mapping", async () => {
  let kitsuCalls = 0;
  const api = load("src/views/detail/use-anime-anilist-details.ts", {
    react: { useEffect: () => {}, useState: () => [null, () => {}] },
    "@/lib/anilist/entry": {
      anilistAnimeEntry: async (id: number) => (id === 63181 ? { id: 204389 } : null),
    },
    "@/lib/anilist/media-details": { fetchAnilistMediaDetails: async () => null },
    "@/lib/providers/anime-mapping": {
      kitsuToAnilist: async () => {
        kitsuCalls++;
        return 180523;
      },
    },
  }) as {
    resolveDetailAnilistId: (canonical: string, requested?: string) => Promise<number | null>;
  };
  assert.equal(await api.resolveDetailAnilistId("kitsu:48834", "mal:63181"), 204389);
  assert.equal(await api.resolveDetailAnilistId("kitsu:48834", "anilist:204389"), 204389);
  assert.equal(kitsuCalls, 0);
  assert.equal(await api.resolveDetailAnilistId("kitsu:48834"), 180523);
});

test("calendar anime entry opens without a trailing episode in its title", () => {
  const api = load("src/views/calendar/utils.ts", {}) as {
    calendarToMeta: (item: Record<string, unknown>) => { id: string; name: string };
    calendarEpisodeHint: (item: Record<string, unknown>) => { season: number; episode: number };
  };
  const item = {
    id: "mal:63181:1:9",
    type: "tv",
    name: "A Wild Last Boss Appeared! Season 2 E09",
    poster: null,
    background: null,
    releaseDate: "2026-11-21",
    isAnime: true,
    overview: "",
    voteAverage: 0,
  };
  assert.deepEqual(api.calendarEpisodeHint(item), { season: 1, episode: 9 });
  assert.deepEqual(
    { id: api.calendarToMeta(item).id, name: api.calendarToMeta(item).name },
    { id: "mal:63181", name: "A Wild Last Boss Appeared! Season 2" },
  );
});

test("detail banner follows opened anime or verified season owner", () => {
  const detail = readFileSync("src/views/detail.tsx", "utf8");
  assert.match(detail, /useAnimeAnilistDetails\(animeCanonicalId, isAnime, meta\.id\)/);
  assert.match(detail, /seasonCanonicalId === animeCanonicalId \? meta\.id : undefined/);
  assert.match(detail, /seasonTrackerSelection\.requiresOwner && !seasonCanonicalId/);
});
