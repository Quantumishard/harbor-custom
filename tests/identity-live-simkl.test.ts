import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildBody, buildAnimeBody, buildEpisodeBody } from "../src/lib/simkl/scrobble-body.ts";

function moduleWith(request: (path: string, options: any) => Promise<unknown>, fallback: () => void) {
  const raw = readFileSync("src/lib/simkl/scrobble.ts", "utf8");
  const js = ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const session = {};
  const mocks: Record<string, any> = {
    "@/lib/active-profile-id": { activeProfileId: () => "profile-a" },
    "./session": { getSession: () => session },
    "@/lib/tracker-resolve": { resolveForMeta: async () => { fallback(); return { ok: false }; } },
    "@/lib/anime-tracker-entry": { resolveTrackerAnimeEntry: async () => null },
    "@/lib/providers/anime-mapping": { anilistToMal: async () => null },
    "@/lib/anime-cw-ids": { getAnimeCwId: () => null },
    "@/lib/anime-detect": { isDetectedAnime: () => true },
    "./client": { simklRequest: request, SimklApiError: class extends Error {} },
    "@/lib/tracker-progress-events": { notifyTrackerProgress: () => {} },
    "./scrobble-body": { buildBody, buildAnimeBody, buildEpisodeBody },
  };
  const mod = { exports: {} as any };
  new Function("require", "module", "exports", js)((name: string) => {
    assert.ok(name in mocks, "unexpected " + name);
    return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}

test("Simkl uses the verified Kitsu anime node, not the original JoJo umbrella ID", async () => {
  const bodies: any[] = [];
  const mod = moduleWith(async (_path, options) => { bodies.push(options.body); return {}; },
    () => { throw Error("unexpected fallback"); });
  const ok = await mod.simklScrobble("start", "mal:14719", {
    season: 6, episode: 1, sourceMetaId: "kitsu:49847",
    kitsuStreamId: "kitsu:49847:1",
  }, 40, { imdb: "tt2359704" }, true);
  assert.equal(ok, true);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].anime.ids, { kitsu: 49847 });
  assert.deepEqual(bodies[0].episode, { season: 1, number: 1 });
  assert.equal(bodies[0].anime.ids.imdb, undefined);
});

test("Simkl verified failure does not retry with guessed catalog metadata", async () => {
  let requested = 0;
  let fallback = 0;
  const mod = moduleWith(async () => { requested++; throw Error("offline"); },
    () => { fallback++; });
  const ok = await mod.simklScrobble("pause", "tt2359704", {
    season: 6, episode: 1, sourceMetaId: "kitsu:49847",
    kitsuStreamId: "kitsu:49847:1",
  }, 40, undefined, true);
  assert.equal(ok, false);
  assert.equal(requested, 1);
  assert.equal(fallback, 0);
});
