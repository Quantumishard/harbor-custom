// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

const E8 = 1794672600; // 2026-11-14T13:30:00Z
const E9 = 1795267800; // 2026-11-21T13:30:00Z

function load(): {
  fetchAnilistAiringSchedule: (id: number) => Promise<Record<number, number> | null>;
  applyAiringSchedule: (
    eps: Array<{ season: number; episode: number; airDate?: string }>,
    schedule: Record<number, number> | null,
  ) => void;
} {
  const source = readFileSync("src/lib/anilist/next-airing.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "./client") return { anilistRequest: async () => ({}) };
    if (id === "@/lib/media-cache")
      return {
        loadMedia: async (_key: string, _params: unknown, loader: () => Promise<unknown>) => ({
          value: await loader(),
        }),
      };
    throw new Error(`unexpected import ${id}`);
  }, exports);
  return exports as never;
}

test("the schedule replaces provider dates with AniList air times", () => {
  const api = load();
  const eps = [
    { season: 1, episode: 7, airDate: "2026-11-14T13:30:00.000Z" },
    { season: 1, episode: 8, airDate: "2026-11-21T13:30:00.000Z" },
  ];
  api.applyAiringSchedule(eps, { 7: E8, 8: E9 });
  assert.equal(eps[0].airDate, new Date(E8 * 1000).toISOString());
  assert.equal(eps[1].airDate, new Date(E9 * 1000).toISOString());
});

test("a multi-season list is not rewritten from entry-relative numbers", () => {
  const api = load();
  const eps = [
    { season: 1, episode: 8, airDate: "old" },
    { season: 2, episode: 8, airDate: "old" },
  ];
  api.applyAiringSchedule(eps, { 8: E9 });
  assert.equal(eps[0].airDate, "old");
  assert.equal(eps[1].airDate, "old");
});

test("fetchAnilistAiringSchedule returns a numeric episode map", async () => {
  const source = readFileSync("src/lib/anilist/next-airing.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "./client")
      return {
        anilistRequest: async () => ({
          Media: {
            id: 204389,
            airingSchedule: {
              nodes: [
                { episode: 8, airingAt: E8 },
                { episode: 9, airingAt: E9 },
              ],
            },
          },
        }),
      };
    if (id === "@/lib/media-cache")
      return {
        loadMedia: async (_key: string, _params: unknown, loader: () => Promise<unknown>) => ({
          value: await loader(),
        }),
      };
    throw new Error(`unexpected import ${id}`);
  }, exports);
  const schedule = await (
    exports as { fetchAnilistAiringSchedule: (id: number) => Promise<Record<number, number>> }
  ).fetchAnilistAiringSchedule(204389);
  assert.deepEqual(schedule, { 8: E8, 9: E9 });
});


test("season-zero specials keep their own airdate when regular S1E1 is rescheduled", () => {
  const api = load();
  const episodes = [
    { season: 0, episode: 1, airDate: "2000-01-01T00:00:00.000Z" },
    { season: 1, episode: 1, airDate: "2001-01-01T00:00:00.000Z" },
  ];
  api.applyAiringSchedule(episodes, { 1: E8 });
  assert.equal(episodes[0].airDate, "2000-01-01T00:00:00.000Z");
  assert.equal(episodes[1].airDate, new Date(E8 * 1000).toISOString());
});

test("anime detail's real airing rewrite preserves mapped S0 specials with native season 1", async () => {
  // Exercise the actual private detail-page implementation, not a duplicate
  // test helper: episode.number can coincide for S0E2 and regular S1E2.
  const detail = readFileSync("src/lib/providers/anime-detail.ts", "utf8");
  const start = detail.indexOf("async function applyAnilistAiringDates(");
  const end = detail.indexOf("\nasync function loadAnimeDetails(", start);
  assert.ok(start >= 0 && end > start, "detail-page airing updater found");
  const compiled = ts.transpileModule(detail.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const updater = new Function(
    "kitsuToAnilist", "fetchAnilistAiringSchedule",
    `${compiled}\nreturn applyAnilistAiringDates;`,
  )(
    async () => 1234,
    async () => ({ 2: E9 }),
  ) as (episodes: Array<{
    number: number;
    seasonNumber: number;
    imdbSeason?: number;
    airdate: string;
  }>, kitsuId: number) => Promise<void>;
  const originalSpecialDate = "2999-01-02T03:04:05.000Z";
  const episodes = [
    { number: 2, seasonNumber: 1, imdbSeason: 0, airdate: originalSpecialDate },
    { number: 2, seasonNumber: 0, imdbSeason: 0, airdate: originalSpecialDate },
    { number: 2, seasonNumber: 1, imdbSeason: 1, airdate: "2999-02-01T00:00:00.000Z" },
  ];
  await updater(episodes, 50024);
  assert.equal(episodes[0].airdate, originalSpecialDate,
    "a mapped special retains its airdate even with native seasonNumber 1");
  assert.equal(episodes[1].airdate, originalSpecialDate,
    "native season-zero specials remain untouched");
  assert.equal(episodes[2].airdate, new Date(E9 * 1000).toISOString(),
    "regular episodes still receive the scheduled AniList date");
});
