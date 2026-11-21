import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { parseRefractHistoryId } from "../src/lib/refract/identity.ts";

function harness() {
  const db = new Map();
  const calls = [];
  let primary = true;
  let enabled = true;
  let key = "rfk_fixture";
  let offline = false;
  const storage = {
    getItem: (name) => db.get(name) ?? null,
    setItem: (name, value) => db.set(name, value),
    removeItem: (name) => db.delete(name),
  };
  const oldStorage = globalThis.localStorage;
  const oldWindow = globalThis.window;
  globalThis.localStorage = storage;
  globalThis.window = new EventTarget();
  const client = {
    getRefractKey: () => key,
    refractEnabled: () => enabled,
    lookupRefract: async (_key, _idType, _id, type, season, episode) =>
      type === "movie"
        ? [{ ids: { refract: "movie-ref" } }]
        : [{ show: { ids: { refract: "show-ref" } }, episode: { season, number: episode } }],
    writeRefractMovie: async (...args) => {
      if (offline) throw new Error("offline");
      calls.push({ kind: "movie", args });
    },
    writeRefractEpisode: async (...args) => {
      if (offline) throw new Error("offline");
      calls.push({ kind: "episode", args });
    },
    RefractApiError: class RefractApiError extends Error {
      constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
        this.retryAfterMs = 0;
      }
    },
  };
  const file = readFileSync(new URL("../src/lib/refract/sync.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(file, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(
    (id) => {
      if (id === "@/lib/active-profile-id") return { activeProfileIsPrimary: () => primary };
      if (id === "./client") return client;
      if (id === "./identity") return { parseRefractHistoryId };
      throw new Error(`Unexpected import: ${id}`);
    },
    module,
    module.exports,
  );
  return {
    sync: module.exports,
    apiError: (status) => new client.RefractApiError(status),
    db,
    calls,
    setPrimary: (v) => {
      primary = v;
    },
    setEnabled: (v) => {
      enabled = v;
    },
    setKey: (v) => {
      key = v;
    },
    setLookup: (v) => {
      client.lookupRefract = v;
    },
    setMovieWrite: (v) => {
      client.writeRefractMovie = v;
    },
    setOffline: (v) => {
      offline = v;
    },
    cleanup: () => {
      globalThis.localStorage = oldStorage;
      globalThis.window = oldWindow;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const movieEvent = (id = "tmdb:movie:55") => ({
  id,
  type: "movie",
  name: "Fixture movie",
  at: Date.parse("2026-11-12T21:15:00Z"),
});
const episodeEvent = (id = "tt11280740") => ({
  id,
  type: "series",
  name: "Fixture show",
  season: 2,
  episode: 4,
  at: Date.parse("2026-11-12T21:15:00Z"),
});

test("completed movie is queued and sent once, with repeat watch event deduplicated", async () => {
  const h = harness();
  try {
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].kind, "movie");
    assert.equal(h.calls[0].args[1], "movie-ref");
    assert.equal(h.sync.refractStatus().pending, 0);
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.calls.length, 1);
  } finally {
    h.cleanup();
  }
});

test("completed episode resolves and sends its exact original season and number", async () => {
  const h = harness();
  try {
    h.sync.enqueueRefractWatch(episodeEvent());
    await tick();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].args.slice(1), [
      "show-ref",
      2,
      4,
      Date.parse("2026-11-12T21:15:00Z"),
    ]);
  } finally {
    h.cleanup();
  }
});

test("a TV show TMDB ID must not be treated as a movie", async () => {
  const h = harness();
  try {
    h.sync.enqueueRefractWatch(movieEvent("tmdb:tv:55"));
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().failed, 1);
  } finally {
    h.cleanup();
  }
});

test("nonprimary Harbor profiles never upload another profile's history", async () => {
  const h = harness();
  try {
    h.setPrimary(false);
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().pending, 0);
  } finally {
    h.cleanup();
  }
});

test("offline queue persists and retries without losing the viewing time", async () => {
  const h = harness();
  try {
    h.setOffline(true);
    h.sync.enqueueRefractWatch(episodeEvent());
    await tick();
    assert.equal(h.sync.refractStatus().pending, 1);
    const raw = JSON.parse(h.db.get("harbor.refract.sync.v1"));
    assert.equal(raw.pending[0].watchedAt, Date.parse("2026-11-12T21:15:00Z"));
    h.setOffline(false);
    h.sync.retryRefractSync();
    await tick();
    assert.equal(h.sync.refractStatus().pending, 0);
    assert.equal(h.calls.length, 1);
  } finally {
    h.cleanup();
  }
});

test("disabling sync during a lookup preserves the queued watch without sending it", async () => {
  const h = harness();
  try {
    let finish;
    h.setLookup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    h.setEnabled(false);
    finish([{ ids: { refract: "movie-ref" } }]);
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().pending, 1);
    assert.equal(h.sync.refractStatus().failed, 0);
  } finally {
    h.cleanup();
  }
});

test("replacing the Refract account discards offline retries before connecting the new key", async () => {
  const h = harness();
  try {
    h.setOffline(true);
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.sync.refractStatus().pending, 1);
    assert.equal(h.calls.length, 0);

    // Mirror the connection lifecycle: clear the previous account's queue before saving the key.
    h.sync.resetRefractSync();
    h.setKey("rfk_replacement_fixture");
    h.setOffline(false);
    h.sync.retryRefractSync();
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().pending, 0);

    h.sync.enqueueRefractWatch(movieEvent("tmdb:movie:56"));
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[0], "rfk_replacement_fixture");
  } finally {
    h.cleanup();
  }
});

test("an in-flight lookup for the previous Refract account cannot write to its replacement", async () => {
  const h = harness();
  try {
    let finish;
    h.setLookup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    assert.equal(h.sync.refractStatus().pending, 1);

    h.sync.resetRefractSync();
    h.setKey("rfk_replacement_fixture");
    finish([{ ids: { refract: "old-account-movie" } }]);
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().pending, 0);
    assert.equal(h.sync.refractStatus().synced, 0);

    h.setLookup(async () => [{ ids: { refract: "replacement-movie" } }]);
    h.sync.enqueueRefractWatch(movieEvent("tmdb:movie:56"));
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[0], "rfk_replacement_fixture");
    assert.equal(h.calls[0].args[1], "replacement-movie");
  } finally {
    h.cleanup();
  }
});

test("a bulk history action exceeding remaining capacity is rejected without partial writes", async () => {
  const h = harness();
  try {
    const storeKey = "harbor.refract.sync.v1";
    const now = Date.now();
    const pending = Array.from({ length: 2499 }, (_, i) => ({
      id: `existing-${i}`,
      requestId: `request-${i}`,
      sourceId: `tmdb:movie:${i + 1}`,
      type: "movie",
      watchedAt: now,
      attempts: 0,
      nextAt: i === 0 ? now : now + 60_000,
    }));
    h.db.set(storeKey, JSON.stringify({ pending, recent: {}, failed: [], synced: 0 }));
    h.sync.enqueueRefractWatch(episodeEvent(), {
      episodes: [
        { season: 2, episode: 4 },
        { season: 2, episode: 5 },
      ],
    });
    await tick();

    // One independent queued movie succeeded, but the rejected batch remains visible.
    const stored = JSON.parse(h.db.get(storeKey));
    assert.equal(stored.pending.length, 2498);
    assert.equal(
      stored.pending.some((job) => job.type === "episode"),
      false,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].kind, "movie");
    assert.equal(h.sync.refractStatus().failed, 1);
    assert.equal(h.sync.refractStatus().failureDetails[0].sourceId, episodeEvent().id);
    assert.match(h.sync.refractStatus().failureDetails[0].reason, /queue full/);
    assert.equal(
      h.sync.refractStatus().message,
      "Refract queue full; unable to save another watch",
    );
  } finally {
    h.cleanup();
  }
});

test("reconnecting with the same key during lookup cannot send a job removed by reset", async () => {
  const h = harness();
  try {
    let finish;
    h.setLookup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    h.sync.resetRefractSync();
    finish([{ ids: { refract: "old-movie" } }]);
    await tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.sync.refractStatus().synced, 0);
    assert.equal(h.sync.refractStatus().pending, 0);

    h.setLookup(async () => [{ ids: { refract: "new-movie" } }]);
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[1], "new-movie");
  } finally {
    h.cleanup();
  }
});

test("a same-key queue reset ignores late write completion without suppressing a new viewing", async () => {
  const h = harness();
  try {
    let finish;
    let started;
    const writing = new Promise((resolve) => {
      started = resolve;
    });
    h.setMovieWrite(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    await writing;
    h.sync.resetRefractSync();
    finish();
    await tick();
    const stored = JSON.parse(h.db.get("harbor.refract.sync.v1"));
    assert.equal(stored.synced, 0);
    assert.deepEqual(stored.recent, {});
    assert.equal(stored.pending.length, 0);

    h.setMovieWrite(async (...args) => {
      h.calls.push({ kind: "movie", args });
    });
    h.sync.enqueueRefractWatch(movieEvent());
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.sync.refractStatus().synced, 1);
  } finally {
    h.cleanup();
  }
});

test("account replacement during an in-flight write cannot mark the new queue as synced", async () => {
  const h = harness();
  try {
    let finish;
    let started;
    const writing = new Promise((resolve) => {
      started = resolve;
    });
    h.setMovieWrite(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    await writing;

    h.sync.resetRefractSync();
    h.setKey("rfk_replacement_fixture");
    finish();
    await tick();
    assert.equal(h.sync.refractStatus().pending, 0);
    assert.equal(h.sync.refractStatus().synced, 0);

    h.setMovieWrite(async (...args) => {
      h.calls.push({ kind: "movie", args });
    });
    h.sync.enqueueRefractWatch(movieEvent("tmdb:movie:56"));
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[0], "rfk_replacement_fixture");
    assert.equal(h.sync.refractStatus().synced, 1);
  } finally {
    h.cleanup();
  }
});

test("queue-full warning returns after a failed attempt is successfully retried", async () => {
  const h = harness();
  try {
    const storeKey = "harbor.refract.sync.v1";
    const now = Date.now();
    const pending = Array.from({ length: 2499 }, (_, i) => ({
      id: `existing-${i}`,
      requestId: `request-${i}`,
      sourceId: `tmdb:movie:${i + 1}`,
      type: "movie",
      watchedAt: now,
      attempts: 0,
      nextAt: i === 0 ? now : now + 60_000,
    }));
    h.db.set(storeKey, JSON.stringify({ pending, recent: {}, failed: [], synced: 0 }));
    h.setOffline(true);
    h.sync.enqueueRefractWatch(episodeEvent(), {
      episodes: [
        { season: 2, episode: 4 },
        { season: 2, episode: 5 },
      ],
    });
    await tick();
    assert.equal(h.sync.refractStatus().failed, 1);
    assert.equal(h.sync.refractStatus().message, "Network error; retry scheduled");

    h.setOffline(false);
    h.sync.retryRefractSync();
    await tick();
    assert.equal(h.sync.refractStatus().synced, 16);
    assert.equal(h.sync.refractStatus().failed, 1);
    assert.equal(
      h.sync.refractStatus().message,
      "Refract queue full; unable to save another watch",
    );
  } finally {
    h.cleanup();
  }
});

test("replacement watch queued during superseded lookup flushes without waiting for polling", async () => {
  const h = harness();
  try {
    let finishOld;
    h.setLookup(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    h.sync.enqueueRefractWatch(movieEvent());
    h.sync.resetRefractSync();
    h.setKey("rfk_replacement_fixture");
    h.setLookup(async () => [{ ids: { refract: "replacement-movie" } }]);
    h.sync.enqueueRefractWatch(movieEvent("tmdb:movie:56"));
    assert.equal(h.calls.length, 0);
    finishOld([{ ids: { refract: "old-movie" } }]);
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args[0], "rfk_replacement_fixture");
    assert.equal(h.calls[0].args[1], "replacement-movie");
    assert.equal(h.sync.refractStatus().pending, 0);
    assert.equal(h.sync.refractStatus().synced, 1);
  } finally {
    h.cleanup();
  }
});

test("HTTP 409 remains retryable while 404 and 422 are terminal", async () => {
  for (const status of [409, 404, 422]) {
    const h = harness();
    try {
      let attempts = 0;
      h.setMovieWrite(async (...args) => {
        attempts += 1;
        if (attempts === 1) throw h.apiError(status);
        h.calls.push({ kind: "movie", args });
      });
      h.sync.enqueueRefractWatch(movieEvent());
      await tick();
      assert.equal(h.sync.refractStatus().pending, status === 409 ? 1 : 0);
      assert.equal(h.sync.refractStatus().failed, status === 409 ? 0 : 1);
      if (status === 409) {
        const storeKey = "harbor.refract.sync.v1";
        const stored = JSON.parse(h.db.get(storeKey));
        stored.pending[0].nextAt = 0;
        h.db.set(storeKey, JSON.stringify(stored));
      }
      if (status === 409) {
        const storeKey = "harbor.refract.sync.v1";
        const stored = JSON.parse(h.db.get(storeKey));
        stored.pending[0].nextAt = 0;
        h.db.set(storeKey, JSON.stringify(stored));
      }
      h.sync.retryRefractSync();
      await tick();
      assert.equal(h.calls.length, status === 409 ? 1 : 0);
      assert.equal(h.sync.refractStatus().pending, 0);
      assert.equal(h.sync.refractStatus().failed, status === 409 ? 0 : 1);
    } finally {
      h.cleanup();
    }
  }
});
