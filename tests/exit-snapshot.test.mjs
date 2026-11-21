import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  const refs = [],
    saves = [],
    timers = [];
  let cursor = 0,
    resolve;
  const frame = new Promise((done) => {
    resolve = done;
  });
  const settings = { cwSnapshotFullQuality: true, cwSnapshotRetentionDays: 30 };
  const dependencies = {
    react: {
      useRef: (value) => (refs[cursor++] ??= { current: value }),
      useCallback: (fn) => fn,
      useEffect() {},
    },
    "@/lib/snapshots": {
      captureMpvFrame: () => frame,
      captureFrame: () => null,
      saveSnapshot: (...args) => saves.push(args),
    },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/trickplay": { trickplayGet: () => null },
    "@/lib/player/playback-clock": { getPlaybackPosition: () => 100 },
    "@/lib/stremio": { cloudWriteId: () => "tt123" },
  };
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/views/player/hooks/use-exit-snapshot.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const api = {};
  new Function("require", "exports", "setTimeout", code)(
    (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    api,
    (callback) => {
      timers.push(callback);
    },
  );
  const render = (episode = 1) => {
    cursor = 0;
    return api.useExitSnapshot({
      src: { meta: { id: "tmdb:123" }, url: "fixture", episode: { season: 1, episode } },
      engine: "mpv",
      status: "paused",
      durationSec: 1000,
      videoMountRef: { current: null },
      resolvedImdbId: null,
      resolvedImdbVerified: true,
      seekPreviewEnabled: false,
    });
  };
  return { render, resolve, saves, timers, settings };
}

test("native frame arriving after exit timeout still persists with the Continue Watching title ID", async () => {
  const h = harness(),
    result = h.render();
  const exit = result.captureExitSnapshot();
  h.timers[0]();
  await exit;
  assert.equal(h.saves.length, 0);
  h.resolve("late-frame");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(h.saves, [["tt123", "late-frame", ["tmdb:123"]]]);
});

test("late capture cannot overwrite the next episode's frame", async () => {
  const h = harness(),
    exit = h.render().captureExitSnapshot();
  h.render(2);
  h.resolve("wrong-episode");
  await exit;
  assert.equal(h.saves.length, 0);
});

test("disabled snapshots do not request a frame", async () => {
  const h = harness();
  h.settings.cwSnapshotRetentionDays = 0;
  await h.render().captureExitSnapshot();
  assert.equal(h.timers.length, 0);
  assert.equal(h.saves.length, 0);
});
