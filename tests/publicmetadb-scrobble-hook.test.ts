import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { randomUuid } from "../src/lib/uuid.ts";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";
import "./_localstorage-stub.ts";
import {
  clearPendingResumes,
  flushPendingResumes,
  retainPendingCompletion,
  listPendingResumes,
  recordPendingResume,
  syncPendingResume,
} from "../src/lib/publicmetadb/pending-sync.ts";
import type { PmdbSaveResumeResponse, PmdbTarget } from "../src/lib/publicmetadb/types.ts";

const scrobbleSource = ts.transpileModule(
  readFileSync("src/lib/publicmetadb/scrobble.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loadScrobble(mocks: Record<string, unknown>) {
  const api = {} as typeof import("../src/lib/publicmetadb/scrobble");
  new Function("require", "exports", scrobbleSource)((name: string) => {
    assert.ok(name in mocks, name);
    return mocks[name];
  }, api);
  return api;
}

function fixture(
  mark: () => Promise<boolean> = async () => true,
  save: () => Promise<PmdbSaveResumeResponse | null> = async () => ({ action: "saved" }),
  resetClockOnCleanup = false,
) {
  clearPendingResumes();
  let now = Date.now();
  let position = 910;
  const watchedAt: string[] = [];
  let deleted = 0;
  let recorded = 0;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  const listeners = new Map<string, () => void>();
  const saves: Array<{ target: PmdbTarget; positionMs: number }> = [];
  let timerId = 0;
  const session = { apiKey: "fixture" };
  const scrobble = loadScrobble({
    "@/lib/uuid": { randomUuid },
    "@/lib/active-profile-id": { activeProfileId: () => "primary" },
    "./mappings": {},
    "./session": { isAuthenticated: () => true, getSession: () => session },
    "./pending-sync": { retainPendingCompletion },
    "./history": {
      markPmdbWatched: (_target: PmdbTarget, timestamp: string) => {
        watchedAt.push(timestamp);
        return mark();
      },
    },
    "./client": {
      pmdbRequest: async (path: string, init: { method: string; body?: any }) => {
        if (init.method === "POST") {
          assert.equal(path, "/api/external/resume");
          const { tmdb_id, media_type, position_ms } = init.body;
          saves.push({ target: { tmdb_id, media_type }, positionMs: position_ms });
          return save();
        }
        if (init.method === "DELETE") {
          deleted++;
          return;
        }
        assert.equal(init.method, "GET");
        return {
          items: [550, 551].map((tmdb_id) => ({
            id: String(tmdb_id),
            tmdb_id,
            media_type: "movie",
          })),
          totalPages: 1,
        };
      },
    },
  });
  const harness = hookHarness(
    "src/lib/publicmetadb/scrobble-hook.ts",
    "usePublicMetaDbScrobble",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
      "@/lib/settings": {
        useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }),
      },
      "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
      "./ids": {
        resolvePmdbTarget: async (id: string) => ({
          tmdb_id: Number(id.split(":")[2]),
          media_type: "movie",
        }),
      },
      "./scrobble": scrobble,
      "./pending-sync": {
        recordPendingResume: (...args: Parameters<typeof recordPendingResume>) => {
          recorded++;
          return recordPendingResume(...args);
        },
        syncPendingResume: (...args: Parameters<typeof syncPendingResume>) => {
          recorded++;
          return syncPendingResume(...args);
        },
      },
    },
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      window: {
        setInterval: (callback: () => void) => {
          const id = ++timerId;
          intervals.set(id, callback);
          return id;
        },
        clearInterval: (id: number) => {
          intervals.delete(id);
          if (resetClockOnCleanup) position = 0;
        },
        setTimeout: (callback: () => void) => {
          const id = ++timerId;
          timeouts.set(id, callback);
          return id;
        },
        clearTimeout: (id: number) => timeouts.delete(id),
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name),
      },
    },
  );
  return {
    render(status = "playing", id = "tmdb:movie:550", imdbId?: string) {
      harness.render({
        src: { meta: { id, type: "movie" }, imdbId },
        snap: { status, durationSec: 1000, positionSec: position },
      });
    },
    async tick(seconds = 1) {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        position++;
        for (const callback of intervals.values()) callback();
        await flushPromises();
      }
    },
    counts: () => ({ marked: watchedAt.length, deleted, recorded }),
    watchedAt,
    replay: () => flushPendingResumes({ hasSession: () => true, save: scrobble.syncPmdbPlayback }),
    saves,
    setPosition: (next: number) => {
      position = next;
    },
    pageHide: () => listeners.get("pagehide")?.(),
    unmount: () => harness.unmount(),
  };
}

test("completed playback sends one watched write across ticks, pause, end and unmount", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick(120);
  h.render("paused");
  h.render("ended");
  h.unmount();
  await flushPromises();
  assert.deepEqual(h.counts(), { marked: 1, deleted: 1, recorded: 1 });
});

test("retry queue joins the live watched write while it is pending", async () => {
  let finish!: (ok: boolean) => void;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.render();
  await flushPromises();
  await h.tick(120);
  h.render("paused");
  assert.deepEqual(h.counts(), { marked: 1, deleted: 0, recorded: 1 });
  const replay = h.replay();
  finish(true);
  assert.deepEqual(await replay, { flushed: 1, remaining: 0 });
  assert.deepEqual(h.counts(), { marked: 1, deleted: 1, recorded: 1 });
  assert.equal(h.saves.length, 0);
  h.unmount();
});

test("failed completion preserves the outbox and retries no faster than once per minute", async () => {
  let attempts = 0;
  const h = fixture(async () => ++attempts > 1);
  h.render();
  await flushPromises();
  await h.tick();
  h.render("paused");
  h.render("playing");
  await h.tick(59);
  assert.deepEqual(h.counts(), { marked: 1, deleted: 0, recorded: 1 });
  await h.tick();
  assert.deepEqual(h.counts(), { marked: 2, deleted: 1, recorded: 2 });
  assert.equal(h.watchedAt[0], h.watchedAt[1]);
  h.unmount();
});

test("a new media identity can complete after the previous title completed", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick();
  h.render("playing", "tmdb:movie:551");
  await flushPromises();
  await h.tick();
  assert.deepEqual(h.counts(), { marked: 2, deleted: 2, recorded: 2 });
  h.unmount();
});

test("metadata enrichment keeps the completion guard for the same playback", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick();
  h.render("playing", "tmdb:movie:550", "tt0137523");
  await flushPromises();
  await h.tick(70);
  h.unmount();
  assert.equal(h.counts().marked, 1);
});

test("PMDB completion below 90% prevents a second watched write at the local threshold", async () => {
  const h = fixture(undefined, async () => ({ action: "completed" }));
  h.setPosition(850);
  h.render();
  await flushPromises();
  h.render("paused");
  await flushPromises();
  assert.equal(h.counts().marked, 1);

  h.setPosition(950);
  h.render("playing");
  h.render("ended");
  h.unmount();
  await flushPromises();
  assert.equal(h.counts().marked, 1);
  assert.equal(h.saves.length, 1);
});

test("a rewatch records a new play for the same item", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick();
  h.setPosition(0);
  h.render("playing", "tmdb:movie:551");
  await flushPromises();
  h.render();
  await flushPromises();
  await h.tick();
  h.setPosition(910);
  h.render("paused");
  await flushPromises();
  assert.equal(h.counts().marked, 2);
  assert.notEqual(h.watchedAt[0], h.watchedAt[1]);
  h.unmount();
});

test("shutdown persists completion for replay even after the player is gone", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  h.pageHide();
  h.unmount();
  assert.equal(h.counts().marked, 0);
  const [saved] = listPendingResumes();
  assert.ok(saved.watchedAt);
  assert.deepEqual(await h.replay(), { flushed: 1, remaining: 0 });
  assert.deepEqual(h.watchedAt, [saved.watchedAt]);
  assert.equal(h.saves.length, 0);
});

test("leaving the player online sends the final rewound position immediately", async () => {
  const h = fixture();
  h.setPosition(800);
  h.render();
  await flushPromises();
  h.setPosition(400);
  h.unmount();
  await flushPromises();
  assert.deepEqual(
    h.saves.map((s) => s.positionMs),
    [400_000],
  );
  assert.equal(h.counts().marked, 0);
  assert.equal(listPendingResumes().length, 0);
});

test("exit captures the position before passive player teardown clears the clock", async () => {
  const h = fixture(undefined, undefined, true);
  h.setPosition(800);
  h.render();
  await flushPromises();
  h.setPosition(400);
  h.unmount();
  await flushPromises();
  assert.deepEqual(
    h.saves.map((s) => s.positionMs),
    [400_000],
  );
});

test("page shutdown persists the rewound position without attempting a live save", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  h.setPosition(400);
  h.pageHide();
  h.unmount();
  await flushPromises();
  assert.equal(h.saves.length, 0);
  assert.equal(h.counts().marked, 0);
  assert.equal(listPendingResumes()[0].positionMs, 400_000);
});

test("a failed exit save remains in the outbox for replay", async () => {
  const h = fixture(undefined, async () => null);
  h.setPosition(400);
  h.render();
  await flushPromises();
  h.unmount();
  await flushPromises();
  assert.equal(h.saves.length, 1);
  assert.equal(listPendingResumes()[0].positionMs, 400_000);
});

test("natural end can complete when the playback clock resets to zero", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  h.setPosition(0);
  h.render("ended");
  await flushPromises();
  assert.equal(h.counts().marked, 1);
  h.unmount();
});

test("changing media uses the previous item's latest position after a backward seek", async () => {
  const h = fixture();
  h.setPosition(800);
  h.render();
  await flushPromises();
  h.setPosition(400);
  await h.tick();
  h.setPosition(0);
  h.render("playing", "tmdb:movie:551");
  await flushPromises();
  assert.deepEqual(
    h.saves.map((s) => [s.target.tmdb_id, s.positionMs]),
    [[550, 401_000]],
  );
  h.unmount();
});
