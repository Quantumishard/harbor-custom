// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

function load(): any {
  const source = readFileSync("src/views/detail/anime-episodes/anime-season-key.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "@/lib/providers/kitsu")
      return { parseKitsuId: (value: string) => Number(/^kitsu:(\d+)$/.exec(value)?.[1]) || null };
    if (id === "@/lib/streams/anime-identity-core")
      return { splitFranchiseDisplaySeason: () => null };
    throw new Error(`unexpected import ${id}`);
  }, exports);
  return exports;
}

const pool = [{ sourceMetaId: "kitsu:49847" }, { sourceMetaId: "kitsu:49847" }];

test("a catalog season switches to the native entry that owns it", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", 6, "kitsu:49847", pool), "kitsu:49847");
});

test("the page stays on its anchor when it already is the owner", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("kitsu:49847", 6, "kitsu:49847", pool), null);
});

test("no switch happens when the owner has no episodes in the loaded pool", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", 6, "kitsu:1", pool), null);
});

test("an invalid or absent season does not switch entries", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", null, "kitsu:49847", pool), null);
  assert.equal(canonicalSeasonOwnerId("tt2359704", 0, "kitsu:49847", pool), null);
});

test("catalog cards use the native progress owner and airdate for the same provider episode", () => {
  const { nativeSeasonRows } = load();
  const catalog = {
    number: 8,
    imdbEpisode: 8,
    imdbSeason: 2,
    imdbId: "tt1",
    airdate: "2026-11-21",
  };
  const native = { ...catalog, number: 3, sourceMetaId: "kitsu:17", airdate: "2026-11-17" };
  const unrelated = { ...catalog, imdbId: "tt2" };
  assert.deepEqual(nativeSeasonRows([catalog, unrelated], [native], 2), [native, unrelated]);
});


test("native provider owner is retained when a TVDB season displays mixed catalog entries", () => {
  const { nativeSeasonOwnerId } = load();
  const native = { page: "tt-example", season: 5, episodes: [{ sourceMetaId: "kitsu:44294" }, { sourceMetaId: "kitsu:44294" }] };
  assert.equal(nativeSeasonOwnerId(native, "tt-example", 5), "kitsu:44294");
  assert.equal(nativeSeasonOwnerId(native, "tt-example", 4), null, "stale previous season must not leak");
  assert.equal(nativeSeasonOwnerId(native, "tt-other", 5), null, "another details page must not leak");
});

test("native owner selection works for a non-JoJo sequel and rejects ambiguous owners", () => {
  const { nativeSeasonOwnerId } = load();
  assert.equal(nativeSeasonOwnerId({ page: "tt-black-clover", season: 2, episodes: [
    { sourceMetaId: "kitsu:50024" }, { sourceMetaId: "kitsu:50024" },
  ] }, "tt-black-clover", 2), "kitsu:50024");
  assert.equal(nativeSeasonOwnerId({ page: "tt-black-clover", season: 2, episodes: [
    { sourceMetaId: "kitsu:13209" }, { sourceMetaId: "kitsu:50024" },
  ] }, "tt-black-clover", 2), null);
  assert.equal(nativeSeasonOwnerId({ page: "tt-black-clover", season: 2, episodes: [] }, "tt-black-clover", 2), null);
});


test("tracker and airing owner requires a matching IMDb provider episode, not a remembered candidate", () => {
  const { verifiedSeasonOwnerFromEpisodes } = load();
  const verified = [{ sourceMetaId: "kitsu:49847", imdbId: "tt2359704", imdbSeason: 6 }];
  assert.equal(verifiedSeasonOwnerFromEpisodes(verified, "tt2359704", 6), "kitsu:49847");
  assert.equal(verifiedSeasonOwnerFromEpisodes(verified, "tt9999999", 6), null,
    "the candidate belongs to another show");
  assert.equal(verifiedSeasonOwnerFromEpisodes(verified, "tt2359704", 5), null,
    "the candidate belongs to another season");
  assert.equal(verifiedSeasonOwnerFromEpisodes([
    { sourceMetaId: "kitsu:44294", imdbId: "tt9999999", imdbSeason: 6 },
  ], "tt2359704", 6), null,
    "an older saved cour cannot become the current tracker/timer owner");
  assert.equal(verifiedSeasonOwnerFromEpisodes([
    ...verified, { sourceMetaId: "kitsu:44294", imdbId: "tt2359704", imdbSeason: 6 },
  ], "tt2359704", 6), null, "ambiguous providers must not pick an arbitrary native owner");
});
