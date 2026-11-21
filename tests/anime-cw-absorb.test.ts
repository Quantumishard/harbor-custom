import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

function harness(existing: unknown) {
  const writes: any[] = [];
  const full = resolve("src/lib/anime-cw-absorb.ts");
  const compiled = ts.transpileModule(readFileSync(full, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "@/lib/cw-dismiss") return { isCwDismissed: () => false };
    if (name === "@/lib/local-cw") {
      return {
        localCwEntryMerged: () => existing,
        saveLocalCw: (entry: any) => writes.push(entry),
      };
    }
    if (name === "@/lib/stremio") {
      return {
        ANIME_CLOUD_ID: /^(kitsu|mal|anilist|anidb):/,
        episodeFromVideoId: (id: string | undefined) => {
          const parts = id?.split(":");
          return parts?.length === 3
            ? { season: Number(parts[1]), episode: Number(parts[2]) }
            : null;
        },
      };
    }
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  return { api: exports as any, writes };
}

const now = new Date().toISOString();

function cloud(overrides: Record<string, unknown> = {}) {
  return {
    _id: "kitsu:49847",
    type: "series",
    name: "Steel Ball Run",
    isAnime: true,
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      season: 6,
      episode: 9,
      timeOffset: 29,
      duration: 100,
      video_id: "kitsu:49847:6:9",
    },
    ...overrides,
  };
}

test("a lower-progress cloud row does not overwrite a more complete local checkpoint", () => {
  const h = harness({
    id: "kitsu:49847",
    positionMs: 97,
    durationMs: 100,
    season: 6,
    episode: 9,
    t: Date.now() - 60_000,
  });

  h.api.absorbCloudAnimeCw([cloud()]);

  assert.equal(h.writes.length, 0);
});

test("a later cloud episode is absorbed even when its progress is lower", () => {
  const h = harness({
    id: "kitsu:49847",
    positionMs: 97,
    durationMs: 100,
    season: 6,
    episode: 9,
    t: Date.now() - 60_000,
  });

  h.api.absorbCloudAnimeCw([
    cloud({
      state: {
        season: 6,
        episode: 10,
        timeOffset: 30,
        duration: 100,
        video_id: "kitsu:49847:6:10",
      },
    }),
  ]);

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].season, 6);
  assert.equal(h.writes[0].episode, 10);
});

test("higher progress on the same episode is absorbed", () => {
  const h = harness({
    id: "kitsu:49847",
    positionMs: 97,
    durationMs: 100,
    season: 6,
    episode: 9,
    t: Date.now() - 60_000,
  });

  h.api.absorbCloudAnimeCw([
    cloud({
      state: {
        season: 6,
        episode: 9,
        timeOffset: 99,
        duration: 100,
        video_id: "kitsu:49847:6:9",
      },
    }),
  ]);

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].positionMs, 99);
});

test("an existing newer checkpoint still wins", () => {
  const h = harness({
    id: "kitsu:49847",
    positionMs: 10,
    durationMs: 100,
    season: 6,
    episode: 9,
    t: Date.now() + 60_000,
  });

  h.api.absorbCloudAnimeCw([cloud()]);

  assert.equal(h.writes.length, 0);
});

test("a first cloud row is absorbed", () => {
  const h = harness(null);

  h.api.absorbCloudAnimeCw([cloud()]);

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].id, "kitsu:49847");
});
