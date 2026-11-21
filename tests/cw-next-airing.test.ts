// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

const SCHEDULE = { episode: 9, airingAt: 1795267800 };

function load(cwId: string | null = null): {
  fetchCwNextAiring: (id: string) => Promise<{ episode: number; airingAt: number } | null>;
  anilistIdForCwItem: (id: string) => Promise<number | null>;
} {
  const source = readFileSync("src/lib/anilist/cw-next-airing.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "./entry")
      return {
        anilistAnimeEntry: async (malId: number) =>
          malId === 63140 ? { id: 204389, idMal: 63140 } : null,
      };
    if (id === "./next-airing") return { fetchAnilistNextAiring: async () => SCHEDULE };
    if (id === "@/lib/anime-cw-ids") return { getAnimeCwId: () => cwId };
    if (id === "@/lib/providers/anime-mapping")
      return {
        kitsuToAnilist: async (kitsuId: number) => (kitsuId === 50404 ? 204389 : null),
      };
    if (id === "@/lib/providers/kitsu")
      return {
        parseKitsuId: (value: string) => {
          const match = /^kitsu:(\d+)$/.exec(value);
          return match ? Number(match[1]) : null;
        },
      };
    throw new Error(`unexpected import ${id}`);
  }, exports);
  return exports as never;
}

test("a MAL card resolves through its AniList entry to the next airing", async () => {
  const api = load();
  assert.equal(await api.anilistIdForCwItem("mal:63140"), 204389);
  assert.deepEqual(await api.fetchCwNextAiring("mal:63140"), SCHEDULE);
});

test("a Kitsu card resolves through the Kitsu-to-AniList bridge", async () => {
  const api = load();
  assert.equal(await api.anilistIdForCwItem("kitsu:50404"), 204389);
  assert.deepEqual(await api.fetchCwNextAiring("kitsu:50404"), SCHEDULE);
});

test("a catalog card uses its recorded anime mapping", async () => {
  const api = load("kitsu:50404");
  assert.deepEqual(await api.fetchCwNextAiring("tt33258199"), SCHEDULE);
});

test("rows without an AniList identity stay untouched", async () => {
  const api = load();
  assert.equal(await api.anilistIdForCwItem("tt1234567"), null);
  assert.equal(await api.fetchCwNextAiring("tt1234567"), null);
});
