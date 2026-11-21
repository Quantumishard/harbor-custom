import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { LibraryItem } from "../src/lib/stremio";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const item = (source: "simkl" | "trakt" | "publicmetadb", id: string): LibraryItem => ({
  _id: id,
  type: "movie",
  name: id,
  external: source,
  removed: false,
  temp: false,
  _ctime: "2026-09-29T12:00:00Z",
  _mtime: "2026-09-29T12:00:00Z",
  state: { lastWatched: "2026-09-29T12:00:00Z", timeOffset: 500, duration: 1000 },
});

function fixture() {
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const listeners: Record<string, () => void> = {};
  type ProviderReply = LibraryItem[] | { items: LibraryItem[]; fresh: boolean };
  const reply = (value: ProviderReply): { items: LibraryItem[]; fresh: boolean } =>
    Array.isArray(value) ? { items: value, fresh: true } : value;
  const providers: Record<"simkl" | "trakt" | "publicmetadb", () => Promise<ProviderReply>> = {
    simkl: async () => [],
    trakt: async () => [],
    publicmetadb: async () => [],
  };
  const connected = { simkl: true, trakt: true, publicmetadb: false };
  const sessions = { simkl: {}, trakt: {}, publicmetadb: {} };
  const detectionBatches: LibraryItem[][] = [];
  const nuvio = {
    signedIn: false,
    active: false,
    fetches: 0,
    fresh: true,
    accountId: "account-a",
    fetch: async (): Promise<LibraryItem[]> => [],
  };
  const mocks: Record<string, unknown> = {
    react: {},
    "@/lib/simkl/playback": {
      fetchSimklPlaybackItems: async () => reply(await providers.simkl()),
      readCachedSimklPlaybackItems: () => [],
      clearCachedSimklPlaybackItems: () => {},
    },
    "@/lib/trakt/playback": {
      fetchTraktPlaybackItems: async () => reply(await providers.trakt()),
      readCachedTraktPlaybackItems: () => [],
      clearCachedTraktPlaybackItems: () => {},
    },
    "@/lib/publicmetadb/playback": {
      fetchPublicMetaDbPlaybackItems: async () => reply(await providers.publicmetadb()),
    },
    "@/lib/publicmetadb/session": {
      getSession: () => (connected.publicmetadb ? sessions.publicmetadb : null),
      subscribeSession: (fn: () => void) => {
        listeners.publicmetadb = fn;
      },
    },
    "@/lib/simkl/session": {
      getSession: () => (connected.simkl ? sessions.simkl : null),
      subscribeSession: (fn: () => void) => {
        listeners.simkl = fn;
      },
    },
    "@/lib/trakt/session": {
      getSession: () => (connected.trakt ? sessions.trakt : null),
      subscribeSession: (fn: () => void) => {
        listeners.trakt = fn;
      },
    },
    "@/lib/stremio": { episodeFromVideoId: () => null },
    "@/lib/tracker-progress-events": {
      TRACKER_PROGRESS_EVENT: "harbor:tracker-progress-updated",
      notifyTrackerProgress: () => {},
    },
    "@/lib/anime-detect": {
      detectAnimeForCw: async (items: LibraryItem[]) => {
        detectionBatches.push(items);
      },
    },
    "@/lib/render-cause": { noteNotify: () => {} },
    "@/lib/startup-trace": { startupEvent: () => {} },
    "@/lib/nuvio/nuvio-playback": {
      fetchNuvioPlaybackItems: async () => {
        nuvio.fetches++;
        return { items: await nuvio.fetch(), fresh: nuvio.fresh };
      },
      readCachedNuvioPlaybackItems: () => [],
      writeCachedNuvioPlaybackItems: () => {},
    },
    "@/lib/nuvio/nuvio-client": {
      isNuvioSignedIn: () => nuvio.signedIn,
      getNuvioAccountId: () => (nuvio.signedIn ? nuvio.accountId : null),
    },
    "@/lib/nuvio/nuvio-sync": {
      isNuvioProviderActive: () => nuvio.active,
      resolveNuvioProfileIndex: () => 1,
    },
  };
  const source = readFileSync(new URL("../src/lib/feed/external-cw.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = {} as typeof import("../src/lib/feed/external-cw");
  new Function("require", "exports", "window", "setTimeout", "clearTimeout", output)(
    (id: string) => {
      assert.ok(id in mocks, id);
      return mocks[id];
    },
    api,
    {
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
    },
    (callback: () => void, delay: number) => {
      const token = {};
      timers.set(token, { callback, delay });
      return token;
    },
    (token: object) => timers.delete(token),
  );
  return {
    api,
    providers,
    connected,
    sessions,
    listeners,
    timers,
    detectionBatches,
    nuvio,
    retry: async () => {
      assert.equal(timers.size, 1);
      const [token, timer] = [...timers][0];
      timers.delete(token);
      timer.callback();
      await settle();
      return timer.delay;
    },
  };
}

test("a partial tracker failure retains its cards and retries without toggling the setting", async () => {
  const h = fixture();
  const old = item("simkl", "old-simkl");
  const fresh = item("trakt", "new-trakt");
  h.providers.simkl = async () => [old];
  await h.api.refreshExternalCw(true);
  h.providers.simkl = async () => {
    throw new Error("Temporary outage");
  };
  h.providers.trakt = async () => [fresh];
  await h.api.refreshExternalCw(true);
  assert.deepEqual(
    new Set(h.api.listExternalCw().map((i) => i._id)),
    new Set([old._id, fresh._id]),
  );
  h.providers.simkl = async () => [item("simkl", "new-simkl")];
  assert.equal(await h.retry(), 1000);
  assert.deepEqual(
    new Set(h.api.listExternalCw().map((i) => i._id)),
    new Set(["new-simkl", fresh._id]),
  );
  assert.equal(h.timers.size, 0);
});

test("a stale provider result keeps its cards and retries instead of counting as fresh", async () => {
  const h = fixture();
  const cached = item("simkl", "cached-simkl");
  h.providers.simkl = async () => ({ items: [cached], fresh: false });
  h.providers.trakt = async () => [];
  await h.api.refreshExternalCw(true);
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    [cached._id],
  );

  h.providers.simkl = async () => [item("simkl", "live-simkl")];
  assert.equal(await h.retry(), 1000);
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["live-simkl"],
  );
});

test("a stale Nuvio cache result does not mark the external refresh fresh", async () => {
  const h = fixture();
  h.connected.simkl = false;
  h.connected.trakt = false;
  h.nuvio.signedIn = true;
  h.nuvio.active = true;
  h.nuvio.fresh = false;
  h.nuvio.fetch = async () => [{ ...item("simkl", "nuvio-cached"), external: "nuvio" }];
  h.api.setExternalCwSources({ simkl: false, trakt: false, publicmetadb: false, nuvio: true });
  await settle();
  await settle();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["nuvio-cached"],
  );

  const fetches = h.nuvio.fetches;
  await h.api.refreshExternalCw();
  assert.equal(h.nuvio.fetches, fetches + 1, "a non-fresh Nuvio read must not be cached as fresh");
});

test("a tracker completion event forces an external CW refresh", async () => {
  const h = fixture();
  let simklCalls = 0;
  h.providers.simkl = async () => {
    simklCalls++;
    return [];
  };
  await h.api.refreshExternalCw(true);
  const before = simklCalls;

  h.listeners["harbor:tracker-progress-updated"]?.();
  await settle();
  await settle();

  assert.ok(simklCalls > before, "the completion event refetched the tracker source");
});

test("changing linked accounts clears the old account even if its replacement is offline", async () => {
  const h = fixture();
  h.providers.simkl = async () => [item("simkl", "old-account")];
  h.providers.trakt = async () => [item("trakt", "keep-trakt")];
  await h.api.refreshExternalCw();
  h.sessions.simkl = {};
  h.providers.simkl = async () => {
    throw new Error("offline");
  };
  h.listeners.simkl();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["keep-trakt"],
  );
  await settle();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["keep-trakt"],
  );
  h.providers.simkl = async () => [item("simkl", "new-account")];
  await h.retry();
  assert.deepEqual(
    new Set(h.api.listExternalCw().map((i) => i._id)),
    new Set(["keep-trakt", "new-account"]),
  );
});

test("PublicMetaDB account changes clear only that account's cards and refresh", async () => {
  const h = fixture();
  h.api.setExternalCwSources({ simkl: true, trakt: true, publicmetadb: true });
  await h.api.refreshExternalCw();
  h.providers.trakt = async () => [item("trakt", "keep-trakt")];
  h.providers.publicmetadb = async () => [item("publicmetadb", "old-pmdb")];
  h.connected.publicmetadb = true;
  h.listeners.publicmetadb();
  await settle();
  assert.deepEqual(
    new Set(h.api.listExternalCw().map((i) => i._id)),
    new Set(["keep-trakt", "old-pmdb"]),
  );

  h.sessions.publicmetadb = {};
  h.providers.publicmetadb = async () => {
    throw new Error("offline");
  };
  h.listeners.publicmetadb();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["keep-trakt"],
  );
  await settle();
  h.providers.publicmetadb = async () => [item("publicmetadb", "new-pmdb")];
  await h.retry();
  assert.deepEqual(
    new Set(h.api.listExternalCw().map((i) => i._id)),
    new Set(["keep-trakt", "new-pmdb"]),
  );

  h.connected.publicmetadb = false;
  h.listeners.publicmetadb();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["keep-trakt"],
  );
  await settle();
});

test("tracker progress enters shared anime detection without waiting for the Stremio library", async () => {
  const h = fixture();
  const trackerItem = item("trakt", "tt101");
  const knownAnime = { ...item("simkl", "tt102"), isAnime: true };
  h.providers.trakt = async () => [trackerItem];
  h.providers.simkl = async () => [knownAnime];
  await h.api.refreshExternalCw(true);
  assert.deepEqual(h.detectionBatches, [[trackerItem]]);
  assert.equal(h.api.listExternalCw().length, 2);
});

test("PublicMetaDB and Trakt collapse when PMDB resolves the show's IMDb id", async () => {
  const h = fixture();
  h.connected.publicmetadb = true;
  h.providers.trakt = async () => [
    {
      ...item("trakt", "tt3032476"),
      state: {
        ...item("trakt", "tt3032476").state!,
        lastWatched: "2026-09-29T11:00:00Z",
      },
    },
  ];
  h.providers.publicmetadb = async () => [
    {
      ...item("publicmetadb", "tt3032476"),
      state: {
        ...item("publicmetadb", "tt3032476").state!,
        lastWatched: "2026-09-29T12:00:00Z",
      },
    },
  ];
  h.api.setExternalCwSources({ simkl: true, trakt: true, publicmetadb: true });
  await settle();
  await h.api.refreshExternalCw(true);

  const cards = h.api.listExternalCw();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].external, "publicmetadb", "newest progress wins");
});

test("cold-start partial failures use bounded retries even when the other tracker succeeds empty", async () => {
  const h = fixture();
  let calls = 0;
  h.providers.simkl = async () => {
    calls++;
    throw new Error("Not ready");
  };
  await h.api.refreshExternalCw();
  for (const delay of [1000, 4000, 10000]) assert.equal(await h.retry(), delay);
  assert.equal(calls, 4);
  assert.equal(h.timers.size, 0);
});

test("a response arriving after disabling both sources cannot restore their cards", async () => {
  const h = fixture();
  let resolve!: (items: LibraryItem[]) => void;
  h.providers.simkl = () =>
    new Promise((done) => {
      resolve = done;
    });
  const load = h.api.refreshExternalCw();
  h.api.setExternalCwSources({ simkl: false, trakt: false });
  resolve([item("simkl", "disabled")]);
  await load;
  assert.deepEqual(h.api.listExternalCw(), []);
  assert.equal(h.timers.size, 0);
});

test("a non-forced duplicate refresh shares the active request without discarding it", async () => {
  const h = fixture();
  let resolve!: (items: LibraryItem[]) => void;
  let calls = 0;
  h.providers.simkl = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const load = h.api.refreshExternalCw();
  const duplicate = h.api.refreshExternalCw();
  assert.equal(load, duplicate);
  resolve([item("simkl", "new")]);
  await load;
  assert.equal(calls, 1);
  assert.equal(h.api.listExternalCw()[0]._id, "new");
});

test("forced refreshes during one request share a single follow-up", async () => {
  const h = fixture();
  let calls = 0;
  let release: (() => void) | undefined;
  h.providers.simkl = () => {
    calls++;
    if (calls === 1) {
      return new Promise<LibraryItem[]>((resolve) => {
        release = () => resolve([item("simkl", "first")]);
      });
    }
    return Promise.resolve([item("simkl", "second")]);
  };
  const load = h.api.refreshExternalCw();
  const a = h.api.refreshExternalCw(true, "data");
  const b = h.api.refreshExternalCw(true, "data");
  const c = h.api.refreshExternalCw(true, "data");
  assert.equal(a, b);
  assert.equal(b, c);
  release?.();
  await load;
  await a;
  assert.equal(calls, 2);
  // The coalesced follow-up must not swallow a later forced refresh.
  await h.api.refreshExternalCw(true);
  assert.equal(calls, 3);
});

test("a forced owner refresh during the same owner's request does not fetch again", async () => {
  const h = fixture();
  let calls = 0;
  let release: (() => void) | undefined;
  h.providers.simkl = () => {
    calls++;
    if (calls === 1)
      return new Promise<LibraryItem[]>((resolve) => {
        release = () => resolve([item("simkl", "only")]);
      });
    return Promise.resolve([item("simkl", "second")]);
  };
  const load = h.api.refreshExternalCw();
  assert.equal(h.api.refreshExternalCw(true, "owner"), load);
  release?.();
  await load;
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["only"],
  );
});

test("a forced data refresh fetches again while the same owner's request runs", async () => {
  const h = fixture();
  let calls = 0;
  let releaseOld: ((items: LibraryItem[]) => void) | undefined;
  h.providers.simkl = () => {
    calls++;
    if (calls === 1)
      return new Promise<LibraryItem[]>((resolve) => {
        releaseOld = resolve;
      });
    return Promise.resolve([item("simkl", "after-progress-change")]);
  };
  const load = h.api.refreshExternalCw();
  const forced = h.api.refreshExternalCw(true);
  assert.notEqual(forced, load);
  releaseOld?.([item("simkl", "before-progress-change")]);
  await load;
  await forced;
  assert.equal(calls, 2);
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["after-progress-change"],
  );
});

test("an in-flight response from the previous account cannot restore its cards", async () => {
  const h = fixture();
  let calls = 0;
  let releaseOld: ((items: LibraryItem[]) => void) | undefined;
  let releaseNew: ((items: LibraryItem[]) => void) | undefined;
  h.providers.simkl = () => {
    calls++;
    return new Promise<LibraryItem[]>((resolve) => {
      if (calls === 1) releaseOld = resolve;
      else releaseNew = resolve;
    });
  };
  const load = h.api.refreshExternalCw();
  h.sessions.simkl = {};
  h.listeners.simkl();
  assert.deepEqual(h.api.listExternalCw(), []);
  releaseOld?.([item("simkl", "old-account")]);
  await load;
  // The follow-up has started but not finished: the old response must be dropped.
  assert.deepEqual(h.api.listExternalCw(), []);
  releaseNew?.([item("simkl", "new-account")]);
  await settle();
  await settle();
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["new-account"],
  );
  assert.equal(calls, 2);
});

test("a failed fetch for the new account does not resurrect the previous account's cards", async () => {
  const h = fixture();
  let calls = 0;
  let releaseOld: ((items: LibraryItem[]) => void) | undefined;
  h.providers.simkl = () => {
    calls++;
    if (calls === 1)
      return new Promise<LibraryItem[]>((resolve) => {
        releaseOld = resolve;
      });
    return Promise.reject(new Error("new account offline"));
  };
  const load = h.api.refreshExternalCw();
  h.sessions.simkl = {};
  h.listeners.simkl();
  releaseOld?.([item("simkl", "old-account")]);
  await load;
  await settle();
  await settle();
  assert.deepEqual(h.api.listExternalCw(), []);
  assert.equal(calls, 2);
});

test("switching Nuvio accounts on the same slot discards an in-flight response", async () => {
  const h = fixture();
  h.connected.simkl = false;
  h.connected.trakt = false;
  h.nuvio.signedIn = true;
  h.nuvio.active = true;
  const pending: Array<(items: LibraryItem[]) => void> = [];
  h.nuvio.fetch = () =>
    new Promise<LibraryItem[]>((resolve) => {
      pending.push(resolve);
    });

  h.api.setExternalCwSources({ simkl: false, trakt: false, publicmetadb: false, nuvio: true });
  assert.equal(h.nuvio.fetches, 1);
  // Establish account A as the last observed session while its fetch is running.
  h.listeners["harbor:nuvio-state-changed"]();
  assert.equal(h.nuvio.fetches, 1);

  h.nuvio.accountId = "account-b";
  h.listeners["harbor:nuvio-state-changed"]();
  assert.deepEqual(h.api.listExternalCw(), []);
  pending[0]([{ ...item("simkl", "old-account"), external: "nuvio" }]);
  await settle();
  await settle();

  assert.equal(h.nuvio.fetches, 2, "account B must receive its own fetch");
  assert.deepEqual(h.api.listExternalCw(), [], "account A must never become visible");
  assert.deepEqual(
    h.api.getCachedNuvioItemsForSlot(1),
    [],
    "late A data must not pollute slot cache",
  );

  pending[1]([{ ...item("simkl", "new-account"), external: "nuvio" }]);
  await settle();
  await settle();
  assert.deepEqual(
    h.api.listExternalCw().map((entry) => entry._id),
    ["new-account"],
  );
});

test("switching Nuvio accounts clears visible cards even when the replacement is offline", async () => {
  const h = fixture();
  h.connected.simkl = false;
  h.connected.trakt = false;
  h.nuvio.signedIn = true;
  h.nuvio.active = true;
  h.nuvio.fetch = async () => [{ ...item("simkl", "account-a-card"), external: "nuvio" }];
  h.api.setExternalCwSources({ simkl: false, trakt: false, publicmetadb: false, nuvio: true });
  await settle();
  await settle();
  h.listeners["harbor:nuvio-state-changed"]();
  await settle();
  await settle();
  assert.deepEqual(
    h.api.listExternalCw().map((entry) => entry._id),
    ["account-a-card"],
  );

  h.nuvio.accountId = "account-b";
  h.nuvio.fetch = async () => {
    throw new Error("account B is offline");
  };
  h.listeners["harbor:nuvio-state-changed"]();
  assert.deepEqual(h.api.listExternalCw(), [], "old account cards must disappear synchronously");
  await settle();
  await settle();
  assert.deepEqual(h.api.listExternalCw(), [], "failed replacement must not restore old cards");
});

test("a profile-change event does not restore previous Nuvio account's slot cache", async () => {
  const h = fixture();
  h.connected.simkl = false;
  h.connected.trakt = false;
  h.nuvio.signedIn = true;
  h.nuvio.active = true;
  h.nuvio.fetch = async () => [{ ...item("simkl", "account-a-card"), external: "nuvio" }];
  h.api.setExternalCwSources({ simkl: false, trakt: false, publicmetadb: false, nuvio: true });
  await settle();
  await settle();
  assert.deepEqual(
    h.api.getCachedNuvioItemsForSlot(1).map((entry) => entry._id),
    ["account-a-card"],
  );

  h.nuvio.accountId = "account-b";
  h.nuvio.fetch = async () => {
    throw new Error("account B is offline");
  };
  h.listeners["harbor:active-profile-changed"]();
  assert.deepEqual(h.api.getCachedNuvioItemsForSlot(1), []);
  assert.deepEqual(h.api.listExternalCw(), []);
  await settle();
  await settle();
  assert.deepEqual(h.api.listExternalCw(), []);
});

test("a successful empty response removes old cards, unlike a failed response", async () => {
  const h = fixture();
  h.providers.simkl = async () => [item("simkl", "old")];
  await h.api.refreshExternalCw();
  h.providers.simkl = async () => [];
  await h.api.refreshExternalCw(true);
  assert.deepEqual(h.api.listExternalCw(), []);
  assert.equal(h.timers.size, 0);
});

test("a stale provider result is shown but does not count as a fresh refresh", async () => {
  const h = fixture();
  let calls = 0;
  h.providers.simkl = async () => {
    calls += 1;
    return { items: [item("simkl", "cached-simkl")], fresh: false };
  };
  await h.api.refreshExternalCw(true);
  assert.deepEqual(
    h.api.listExternalCw().map((i) => i._id),
    ["cached-simkl"],
  );
  // The stale result leaves fetchedAt at zero, so a normal refresh fetches again.
  await h.api.refreshExternalCw();
  assert.equal(calls, 2);
});

test("willRefreshExternalCw reflects provider mode and freshness", async () => {
  const h = fixture();
  h.api.setExternalCwSources({ trakt: true, simkl: true, publicmetadb: false, nuvio: true });
  h.nuvio.signedIn = true;
  h.nuvio.active = true;

  assert.equal(h.api.willRefreshExternalCw(false), true);
  assert.equal(h.api.willRefreshExternalCw(true), true);

  await h.api.refreshExternalCw(true);
  assert.equal(h.api.willRefreshExternalCw(false), false);
  assert.equal(h.api.willRefreshExternalCw(true), true);

  h.api.setExternalCwSources({ trakt: true, simkl: true, publicmetadb: false, nuvio: false });
  assert.equal(h.api.willRefreshExternalCw(true), false);
  h.api.setExternalCwSources({ trakt: true, simkl: true, publicmetadb: false, nuvio: true });
  h.nuvio.signedIn = false;
  assert.equal(h.api.willRefreshExternalCw(true), false);
});

test("identical merged items do not emit a new detection batch", async () => {
  const h = fixture();
  h.providers.simkl = async () => [item("simkl", "same")];
  await h.api.refreshExternalCw(true);
  const batches = h.detectionBatches.length;
  await h.api.refreshExternalCw(true);
  assert.equal(h.detectionBatches.length, batches);
});

test("the Nuvio mount refresh is freshness-gated", () => {
  const source = readFileSync(new URL("../src/lib/feed/external-cw.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const fresh = fetchedAt > 0 && Date\.now\(\) - fetchedAt < STALE_MS;[\s\S]*?refreshExternalCw\(!fresh\)/,
  );
});
