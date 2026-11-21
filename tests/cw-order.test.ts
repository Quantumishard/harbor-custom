// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";
import type { LibraryItem } from "../src/lib/stremio";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

type ResumeEntry = { ms: number; t: number; source?: string };

function load() {
  const resume = new Map<string, ResumeEntry>();
  const output = ts.transpileModule(read("src/lib/cw-order.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", output)(
    (name: string) => {
      if (name === "@/lib/resume") {
        return {
          readResumeEntry: (id: string, season?: number, episode?: number) => {
            const key =
              typeof season === "number" && typeof episode === "number"
                ? `${id}|s${season}e${episode}`
                : id;
            return resume.get(key) ?? null;
          },
        };
      }
      if (name === "@/lib/stremio") {
        return {
          resolvedEpisodeCoords: (item: LibraryItem) => {
            const season = item.state?.season;
            const episode = item.state?.episode;
            return typeof season === "number" && typeof episode === "number"
              ? { season, episode }
              : null;
          },
        };
      }
      throw new Error(`Unexpected dependency ${name}`);
    },
    module,
    module.exports,
  );
  return {
    resume,
    sortCwFinal: module.exports.sortCwFinal as <T extends LibraryItem>(items: readonly T[]) => T[],
    cwPlaybackAt: module.exports.cwPlaybackAt as (item: LibraryItem) => number,
  };
}

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    _id: "tt1",
    type: "series",
    name: "Fixture",
    removed: false,
    temp: false,
    _ctime: "2026-01-01T00:00:00.000Z",
    _mtime: "2026-01-01T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000, season: 1, episode: 1 },
    ...overrides,
  };
}

test("the card with the newest real playback comes first", () => {
  const h = load();
  const older = item({
    _id: "older",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-15T10:00:00.000Z" },
  });
  const newer = item({
    _id: "newer",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-17T10:00:00.000Z" },
  });

  assert.deepEqual(
    h.sortCwFinal([older, newer]).map((entry) => entry._id),
    ["newer", "older"],
  );
});

test("a deduped card uses the newest member checkpoint (advanced card moves forward)", () => {
  const h = load();
  const advanced = item({
    _id: "advanced",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-10T10:00:00.000Z" },
    cwMembers: [
      item({
        _id: "advanced-member",
        state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-17T12:00:00.000Z" },
      }),
    ],
  });
  const other = item({
    _id: "other",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-16T10:00:00.000Z" },
  });

  assert.deepEqual(
    h.sortCwFinal([other, advanced]).map((entry) => entry._id),
    ["advanced", "other"],
  );
});

test("a local resume entry is used when no checkpoint carries a timestamp", () => {
  const h = load();
  const resumed = item({
    _id: "resumed",
    _mtime: "2026-11-01T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000, season: 2, episode: 3 },
  });
  h.resume.set("resumed|s2e3", { ms: 500, t: Date.parse("2026-11-17T10:00:00.000Z") });
  const timed = item({
    _id: "timed",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-16T10:00:00.000Z" },
  });

  assert.deepEqual(
    h.sortCwFinal([timed, resumed]).map((entry) => entry._id),
    ["resumed", "timed"],
  );
  assert.equal(h.cwPlaybackAt(resumed), Date.parse("2026-11-17T10:00:00.000Z"));
});

test("imported resume timestamps never order a card by fetch time", () => {
  const h = load();
  const imported = item({
    _id: "imported",
    _mtime: "2026-11-10T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000, season: 1, episode: 2 },
  });
  h.resume.set("imported|s1e2", {
    ms: 500,
    t: Date.parse("2026-11-18T00:00:00.000Z"),
    source: "trakt",
  });
  const played = item({
    _id: "played",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-15T00:00:00.000Z" },
  });

  assert.deepEqual(
    h.sortCwFinal([imported, played]).map((entry) => entry._id),
    ["played", "imported"],
  );
});

test("_mtime is only a fallback and maintenance bumps do not beat playback", () => {
  const h = load();
  const maintained = item({
    _id: "maintained",
    _mtime: "2026-11-18T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-10T00:00:00.000Z" },
  });
  const recent = item({
    _id: "recent",
    _mtime: "2026-11-01T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000, lastWatched: "2026-11-17T00:00:00.000Z" },
  });
  assert.deepEqual(
    h.sortCwFinal([maintained, recent]).map((entry) => entry._id),
    ["recent", "maintained"],
  );

  const untimed = item({
    _id: "untimed",
    _mtime: "2026-11-16T00:00:00.000Z",
    state: { timeOffset: 0, duration: 1000 },
  });
  assert.equal(h.cwPlaybackAt(untimed), Date.parse("2026-11-16T00:00:00.000Z"));
});

test("equal timestamps keep the incoming order (stable sort)", () => {
  const h = load();
  const stamp = "2026-11-17T00:00:00.000Z";
  const first = item({
    _id: "first",
    state: { timeOffset: 0, duration: 1000, lastWatched: stamp },
  });
  const second = item({
    _id: "second",
    state: { timeOffset: 0, duration: 1000, lastWatched: stamp },
  });
  const third = item({
    _id: "third",
    state: { timeOffset: 0, duration: 1000, lastWatched: stamp },
  });

  assert.deepEqual(
    h.sortCwFinal([third, first, second]).map((entry) => entry._id),
    ["third", "first", "second"],
  );
});

test("an empty row stays empty", () => {
  const h = load();
  assert.deepEqual(h.sortCwFinal([]), []);
});
