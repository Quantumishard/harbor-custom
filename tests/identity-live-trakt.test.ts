import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function harness() {
  const src = readFileSync("src/lib/trakt/resolve.ts", "utf8");
  const js = ts.transpileModule(src, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const writes: Array<{ kind: string; target: any }> = [];
  let guessed = 0;
  const owner = {};
  const mocks: Record<string, any> = {
    "@/lib/tracker-resolve": {
      resolveForMeta: async () => { guessed++; return { ok: false }; },
      resolvedToTraktTarget: () => null,
    },
    "@/lib/tracker-resolve/special": { resolveSpecialMovie: async () => null },
    "./history": { pushWatched: async (t: any) => {
      writes.push({ kind: "watched", target: t });
      return true;
    } },
    "./scrobble": {
      scrobbleStart: async (t: any) => {
        writes.push({ kind: "start", target: t }); return "failed";
      },
      scrobblePause: async (t: any) => {
        writes.push({ kind: "pause", target: t }); return "recorded";
      },
      scrobbleStop: async (t: any) => {
        writes.push({ kind: "stop", target: t }); return "failed";
      },
    },
    "@/lib/active-profile-id": { activeProfileId: () => "test-profile" },
    "./session": { getSession: () => owner },
    "@/lib/tracker-progress-events": { notifyTrackerProgress: () => {} },
  };
  const mod = { exports: {} as any };
  new Function("require", "module", "exports", js)((name: string) => {
    assert.ok(name in mocks, "unexpected import: " + name);
    return mocks[name];
  }, mod, mod.exports);
  return { api: mod.exports, writes, getGuessed: () => guessed };
}

test("Trakt uses verified TVDB episode for start and completion without guessed fallback", async () => {
  const h = harness();
  const target = {
    kind: "episode", show: { ids: { tvdb: 262954 } },
    season: 6, number: 1,
  };
  await h.api.commitPlaybackState("start", target, "mal:14719", 10, undefined, true);
  assert.deepEqual(h.writes[0], { kind: "start", target });
  assert.equal(h.getGuessed(), 0);
  const result = await h.api.commitWatchedEpisode(target, "mal:14719", 95, undefined, true);
  assert.equal(result, "recorded");
  assert.deepEqual(h.writes.slice(1), [
    { kind: "stop", target }, { kind: "watched", target },
  ]);
  assert.equal(h.getGuessed(), 0);
});

test("a failed verified Trakt update never retries with the unverified original show", async () => {
  const h = harness();
  const target = {
    kind: "episode", show: { ids: { tvdb: 262954 } },
    season: 6, number: 1,
  };
  const result = await h.api.commitWatchedEpisode(target, "mal:14719", 30, undefined, true);
  assert.equal(result, "failed");
  assert.equal(h.getGuessed(), 0);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].target, target);
});
