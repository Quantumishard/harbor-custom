import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the production hooks across rerenders, including their committed
// cleanup and refs; a helper reimplementation of scrobble policy is insufficient.
function host(path: string, exported: string, mocks: Record<string, any>) {
  const refs: any[] = [];
  const callbacks: any[] = [];
  const effects: any[] = [];
  const listeners = new Map<string, () => void>();
  let ri = 0, ci = 0, ei = 0;
  let pending: any[] = [];
  const same = (a: any[], b: any[]) =>
    a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value: any) { const i = ri++; return (refs[i] ??= { current: value }); },
    useCallback(fn: any, deps: any[]) {
      const i = ci++;
      if (!callbacks[i] || !same(callbacks[i].deps, deps)) callbacks[i] = { fn, deps };
      return callbacks[i].fn;
    },
    useEffect(fn: any, deps: any[]) {
      const i = ei++;
      if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, fn, deps });
    },
    useLayoutEffect(fn: any, deps: any[]) {
      const i = ei++;
      if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, fn, deps, layout: true });
    },
  };
  const source = readFileSync(path, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: Record<string, any> = {};
  const win = {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 2, clearTimeout: () => {},
  };
  new Function("require", "exports", "window", "fetch", js)(
    (name: string) => {
      if (name === "react") return react;
      assert.ok(name in mocks, `Unexpected ${name} in ${path}`);
      return mocks[name];
    }, exports, win, mocks.__fetch ?? (() => Promise.resolve({ ok: true })),
  );
  return {
    render(args: any) {
      ri = ci = ei = 0;
      pending = [];
      exports[exported](args);
      pending.sort((a, b) => Number(!!b.layout) - Number(!!a.layout));
      for (const { i } of pending) effects[i]?.cleanup?.();
      for (const { i, fn, deps, layout } of pending)
        effects[i] = { deps, layout, cleanup: fn() };
    },
    event(name: string) { const listener = listeners.get(name); assert.ok(listener); listener(); },
  };
}

const episode = (native: string) => ({
  season: 6, episode: 1, sourceMetaId: native, kitsuStreamId: `${native}:1`,
});
const src = (native: string) => ({
  meta: { id: "tt1234567", type: "series", name: "Reverified anime" },
  episode: episode(native), url: "https://video.example/episode",
});
const snap = (status: string) => ({ status, positionSec: 300, durationSec: 1000 });
const proof = (native: string, id: number) => ({
  phase: "ready" as const,
  proof: {
    work: { entryId: native }, episode: episode(native),
    traktTarget: { kind: "episode", show: { ids: { tvdb: id } }, season: 6, number: 1 },
    pmdbTarget: { tmdb_id: id, media_type: "tv", season: 6, episode: 1 },
  },
});
const pending = { phase: "resolving" as const, proof: null };

test("Trakt closes the old owner and starts a new session when only verified ownership changes", () => {
  const writes: any[] = [];
  let position = 300;
  const scrobble = (action: string, args: any) => writes.push({
    action, tvdb: args.verifiedTarget?.show?.ids?.tvdb, progress: args.progress,
  });
  const h = host("src/lib/trakt/scrobble-hook.ts", "useTraktScrobble", {
    "./provider": { useTrakt: () => ({ isConnected: true, resolveTarget: () => null, scrobble }) },
    "./config": { TRAKT_API_BASE: "https://trakt.example", TRAKT_API_VERSION: "2", TRAKT_CLIENT_ID: "fake" },
    "./session": { getSession: () => ({ accessToken: "fake" }) },
    "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
  });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: proof("kitsu:111", 100) });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: pending });
  h.render({ src: src("kitsu:222"), snap: snap("playing"), liveScrobble: proof("kitsu:222", 200) });
  position = 980;
  h.render({ src: src("kitsu:222"), snap: snap("ended"), liveScrobble: proof("kitsu:222", 200) });
  assert.deepEqual(writes.map(({ action, tvdb }) => [action, tvdb]), [
    ["start", 100], ["pause", 100], ["start", 200], ["stop", 200],
  ]);
});

test("Simkl never marks the previous native owner watched after same-episode re-verification", async () => {
  const writes: any[] = [];
  let position = 300;
  const h = host("src/lib/simkl/scrobble-hook.ts", "useSimklScrobble", {
    "./provider": { useSimkl: () => ({ isConnected: true }) },
    "./scrobble": {
      simklScrobble: (action: string, _id: string, ep: any) => {
        writes.push([action, ep?.sourceMetaId]); return Promise.resolve(true);
      },
      buildBody: (_id: string, ep: any) => ({ owner: ep?.sourceMetaId }),
    },
    "./scrobble-body": { animeIdentity: () => null },
    "./pending-sync": { recordPendingWatch: () => {} },
    "./record-watched": { recordWatchedFallback: (_id: string, ep: any) => {
      writes.push(["watched", ep?.sourceMetaId]); return Promise.resolve(true);
    } },
    "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
    "@/lib/settings": { useSettings: () => ({ settings: { simklScrobbleEnabled: true } }) },
    "./config": {
      SIMKL_API_BASE: "https://simkl.example", SIMKL_CLIENT_ID: "fake",
      SIMKL_APP_NAME: "Harbor", SIMKL_APP_VERSION: "1", SIMKL_USER_AGENT: "test",
      SIMKL_WATCHED_RATIO: 0.9,
    },
    "./session": { getSession: () => ({ accessToken: "fake" }) },
  });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: proof("kitsu:111", 100) });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: pending });
  h.render({ src: src("kitsu:222"), snap: snap("playing"), liveScrobble: proof("kitsu:222", 200) });
  position = 980;
  h.render({ src: src("kitsu:222"), snap: snap("ended"), liveScrobble: proof("kitsu:222", 200) });
  await Promise.resolve();
  assert.deepEqual(writes, [
    ["start", "kitsu:111"], ["pause", "kitsu:111"],
    ["start", "kitsu:222"], ["watched", "kitsu:222"],
  ]);
});

test("PublicMetaDB persists the outgoing verified target when same episode enters resolving", () => {
  const saved: any[] = [];
  const h = host("src/lib/publicmetadb/scrobble-hook.ts", "usePublicMetaDbScrobble", {
    "@/lib/player/playback-clock": { getPlaybackPosition: () => 500 },
    "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
    "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
    "./ids": { resolvePmdbEpisodeTarget: async () => null, resolvePmdbTarget: async () => null },
    "./scrobble": {
      startPmdbPlayback: () => ({ id: "reproof-session", watched: false, marking: false }),
      endPmdbPlayback: () => {},
      syncPmdbPlayback: async () => true,
    },
    "./pending-sync": {
      recordPendingResume: (target: any, pos: number) => saved.push([target.tmdb_id, pos]),
      syncPendingResume: async (target: any, pos: number) => { saved.push([target.tmdb_id, pos]); return true; },
    },
    "./history": { markPmdbWatched: async () => true },
  });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: proof("kitsu:111", 100) });
  h.render({ src: src("kitsu:111"), snap: snap("playing"), liveScrobble: pending });
  assert.ok(saved.length > 0, "the old target was flushed before being cleared");
  assert.deepEqual(saved[0], [100, 500_000]);
});
