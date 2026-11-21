// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

function load(): any {
  const source = readFileSync("src/lib/tracker-targets.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)(() => ({}), exports);
  return exports;
}

const catalog = ["tt2359704", "tmdb:tv:45790"];
const work = {
  entryId: "kitsu:49847",
  entryEpisode: 9,
  baseEntryId: "kitsu:7158",
  aliases: { kitsu: "kitsu:49847", mal: "mal:61469", anilist: "anilist:190327" },
  catalogIds: catalog,
  evidence: "anizip-delta" as const,
};

test("a resolved work produces all four provider targets with entry-relative episodes", () => {
  const api = load();
  const targets = api.trackerTargetsFor({
    metaId: "tt2359704",
    catalogIds: catalog,
    season: 6,
    episode: 9,
    isAnime: true,
    work,
  });
  const byService = new Map(targets.map((target: any) => [target.service, target]));
  assert.deepEqual(byService.get("trakt")?.providerCoords, { season: 6, episode: 9 });
  assert.equal(byService.get("trakt")?.workEntry, "kitsu:49847");
  assert.equal(byService.get("simkl")?.workEntry, "kitsu:49847");
  assert.equal(byService.get("simkl")?.entryEpisode, 9);
  assert.equal(byService.get("mal")?.workEntry, "mal:61469");
  assert.equal(byService.get("anilist")?.workEntry, "anilist:190327");
  for (const target of targets) assert.equal(target.evidence, "anizip-delta");
});

test("Simkl Path B uses the entry episode, not the provider season coordinates", () => {
  const api = load();
  const simkl = api.trackerTargetFor(
    {
      metaId: "tt2359704",
      catalogIds: catalog,
      season: 6,
      episode: 9,
      isAnime: true,
      work: { ...work, entryEpisode: 3 },
    },
    "simkl",
  );
  assert.equal(simkl.entryEpisode, 3);
  assert.deepEqual(simkl.providerCoords, { season: 6, episode: 9 });
});

test("an anime row without a resolved work fails closed for native services", () => {
  const api = load();
  assert.equal(
    api.trackerTargetFor(
      {
        metaId: "tt2359704",
        catalogIds: catalog,
        season: 6,
        episode: 9,
        isAnime: true,
        work: null,
      },
      "simkl",
    ),
    null,
  );
  assert.equal(
    api.trackerTargetFor(
      {
        metaId: "tt2359704",
        catalogIds: catalog,
        season: 6,
        episode: 9,
        isAnime: true,
        work: null,
      },
      "mal",
    ),
    null,
  );
  assert.equal(
    api.trackerTargetFor(
      {
        metaId: "tt2359704",
        catalogIds: catalog,
        season: 6,
        episode: 9,
        isAnime: true,
        work: null,
      },
      "anilist",
    ),
    null,
  );
  // Trakt can still use the catalog show and provider coordinates.
  assert.ok(
    api.trackerTargetFor(
      {
        metaId: "tt2359704",
        catalogIds: catalog,
        season: 6,
        episode: 9,
        isAnime: true,
        work: null,
      },
      "trakt",
    ),
  );
});

test("missing catalog ids or coordinates never produce a guessed target", () => {
  const api = load();
  assert.equal(
    api.trackerTargetFor(
      { metaId: "kitsu:49847", season: 6, episode: 9, isAnime: true, work },
      "trakt",
    ),
    null,
  );
  assert.equal(
    api.trackerTargetFor(
      { metaId: "tt2359704", catalogIds: catalog, season: 0, episode: 9 },
      "trakt",
    ),
    null,
  );
});

test("the async resolver builds a work from the entry resolver and aliases", async () => {
  const api = load();
  const targets = await api.resolveTrackerTargets(
    { metaId: "tt2359704", catalogIds: catalog, season: 6, episode: 9, isAnime: true },
    {
      resolveEntry: async () => ({ id: "kitsu:49847", episode: 9, baseId: "kitsu:7158" }),
      aliases: async () => ({
        kitsu: "kitsu:49847",
        mal: "mal:61469",
        anilist: "anilist:190327",
      }),
    },
  );
  const simkl = targets.find((target: any) => target.service === "simkl");
  const mal = targets.find((target: any) => target.service === "mal");
  assert.equal(simkl?.workEntry, "kitsu:49847");
  assert.equal(simkl?.entryEpisode, 9);
  assert.equal(mal?.workEntry, "mal:61469");
});

test("an entry-resolver outage produces no targets so callers keep today's behavior", async () => {
  const api = load();
  const targets = await api.resolveTrackerTargets(
    { metaId: "tt2359704", catalogIds: catalog, season: 6, episode: 9, isAnime: true },
    {
      resolveEntry: async () => {
        throw new Error("provider unavailable");
      },
    },
  );
  assert.deepEqual(targets, []);
});
