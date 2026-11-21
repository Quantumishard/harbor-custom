import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const episodeKey = (id: string, s: number, e: number) => `${id}:${s}:${e}`;
const item = (episode = 1, lastWatched = iso(-3600000), id = "tt100") => ({
  _id: id,
  type: "series",
  name: "Fixture series",
  removed: false,
  temp: false,
  _ctime: lastWatched,
  _mtime: lastWatched,
  state: {
    season: 1,
    episode,
    video_id: `${id}:1:${episode}`,
    timeOffset: 300000,
    duration: 1800000,
    lastWatched,
    flaggedWatched: 0,
  },
});
const anchor = (episode = 1, id = "tt100") => ({
  ...item(episode, iso(), id),
  external: "simkl",
  state: { ...item(episode, iso(), id).state, timeOffset: 0, duration: 0, flaggedWatched: 1 },
});
const progress = (episodes = [1], id = "tt100", completedSeries: any[] = []) => ({
  statuses: new Map([[id, "watching"]]),
  watched: new Map([[id, new Set(episodes.map((e) => `1:${e}`))]]),
  watchedAt: new Map([[id, new Map(episodes.map((e) => [`1:${e}`, now]))]]),
  completedSeries,
});

function compile(
  path: string,
  require: (name: string) => any,
  source = readFileSync(path, "utf8"),
  events: Record<string, () => void> = {},
  persistentStorage?: Map<string, string>,
) {
  const module = { exports: {} as any };
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", "window", "document", "localStorage", code)(
    require,
    module,
    module.exports,
    {
      setInterval: (fn: () => void) => {
        events.poll = fn;
        return 1;
      },
      clearInterval: () => {
        delete events.poll;
      },
      addEventListener: (name: string, fn: () => void) => {
        events[name] = fn;
      },
      removeEventListener: (name: string) => {
        delete events[name];
      },
    },
    { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
    {
      getItem: (key: string) => persistentStorage?.get(key) ?? null,
      setItem: (key: string, value: string) => persistentStorage?.set(key, value),
    },
  );
  return module.exports;
}

function harness(persistentStorage = new Map<string, string>()) {
  const events: Record<string, () => void> = {};
  const resumes = new Map<string, any>(),
    manual = new Map<string, boolean>();
  const lastPlayed = new Map<string, any>();
  const dismissed = new Set<string>();
  let settings = { cwSources: { simkl: true }, cwHideCaughtUp: false, cwPerProfile: false };
  let profile = { id: "a" },
    session: object | null = { username: "fixture" };
  let remote: any = progress(),
    remoteReads = 0,
    episodeReads = 0,
    metadataFails = false;
  let episodeGate: Promise<void> | null = null,
    activeReads = 0,
    maxActiveReads = 0,
    resolverReads = 0,
    resolverFails = false,
    resolverGate: Promise<void> | null = null,
    nuvioAccount: string | null = null;
  const readIds: string[] = [];
  let episodes = [1, 2, 3, 4].map((episode) => ({ season: 1, episode, airDate: "2020-01-01" }));
  const states: any[] = [],
    refs: any[] = [],
    effects: any[] = [];
  let stateSlot = 0,
    refSlot = 0,
    effectSlot = 0,
    dirty = false;
  const pending: (() => void)[] = [];
  const modules = new Map<string, any>();
  let params: any[] = [[], "", true, []];
  const mocks: Record<string, any> = {
    react: {
      useState: (initial: any) => {
        const slot = stateSlot++;
        if (!(slot in states)) states[slot] = initial;
        return [
          states[slot],
          (update: any) => {
            const next = typeof update === "function" ? update(states[slot]) : update;
            if (!Object.is(next, states[slot])) {
              states[slot] = next;
              dirty = true;
            }
          },
        ];
      },
      useRef: (current: any) => refs[refSlot++] ?? (refs[refSlot - 1] = { current }),
      useMemo: (fn: any) => fn(),
      useSyncExternalStore: (_subscribe: any, get: any) => get(),
      useEffect: (fn: any, deps: any[]) => {
        const slot = effectSlot++,
          old = effects[slot];
        if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
        pending.push(() => {
          old?.cleanup?.();
          effects[slot] = { deps, cleanup: fn() };
        });
      },
    },
    "@/lib/resume": {
      readResumeEntry: (id: string, s: number, e: number) => resumes.get(episodeKey(id, s, e)),
      lastPlayedEpisode: (id: string) => lastPlayed.get(id),
      readResumeSource: () => undefined,
    },
    "@/lib/manual-watched": {
      manualWatchedState: (id: string, s: number, e: number) => manual.get(episodeKey(id, s, e)),
    },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/profiles": {
      useProfiles: () => ({ activeProfile: profile, profiles: [] }),
      anyProfileSharesStremioWith: () => true,
      stremioSourceProfileId: (active: any) => active?.id ?? null,
    },
    "@/lib/auth": { readActiveStremioAuthKey: () => null },
    "@/lib/active-profile-id": { getNuvioActiveSlot: () => 1 },
    "@/lib/simkl/session": { getSession: () => session, subscribeSession: () => () => {} },
    "@/lib/simkl/list-status": {
      loadSimklProgress: async () => {
        remoteReads++;
        if (remote instanceof Error) throw remote;
        return remote;
      },
      simklWatchedForId: (map: Map<string, Set<string>>, id: string) => map.get(id) ?? new Set(),
      statusForId: (map: Map<string, string>, id: string) => map.get(id),
    },
    "@/lib/cw-dismiss": {
      useCwDismissVersion: () => 0,
      isCwDismissed: (i: any) =>
        dismissed.has(episodeKey(i._id, i.state?.season, i.state?.episode)),
    },
    "@/lib/cw-profile": { privateCwProfileId: () => (settings.cwPerProfile ? profile.id : null) },
    "@/lib/providers/anime-mapping": { relatedLibraryIds: async () => [] },
    "@/lib/anime-detect": { isDetectedAnime: () => false },
    "@/lib/safe-fetch": {
      safeFetch: () => {
        throw new Error("unexpected live request");
      },
    },
    "@/lib/hidden-episodes": { isEpisodeHidden: () => false },
    "@/lib/season-view-pref": { getViewedSeason: () => undefined },
    "@/lib/anime-cw-ids": {
      getAnimeCwId: () => null,
      animeCwIdsVersion: () => 0,
      subscribeAnimeCwIds: () => () => {},
    },
    // The hook's optional airing lookup is independent of episode
    // advancement; keep these suites offline and test airing separately.
    "@/lib/anilist/cw-next-airing": { fetchCwNextAiring: async () => null },
    "@/lib/cw-anime-identity": {
      cwAnimeIdentityKey: () => null,
      cwWarmIdentityKey: (item: any) => JSON.stringify(item),
      dedupeAnimeCw: (items: any[]) => items,
      warmCwAnimeIdentities: async () => {},
    },
    "@/lib/nuvio/nuvio-client": { getNuvioAccountId: () => nuvioAccount },
    "@/lib/anime-tracker-entry": {
      resolveTrackerAnimeEntry: async () => null,
      resolveTrackerAnimeEntryStrict: async () => {
        resolverReads++;
        if (resolverGate) await resolverGate;
        if (resolverFails) throw new Error("resolver offline");
        return null;
      },
    },
    "@/lib/providers/anime-franchise-root": { isSplitFranchiseKitsu: () => false },
    "@/lib/providers/kitsu": { parseKitsuId: () => null },
    "@/lib/providers/jikan": { franchiseDedupKey: (name: string) => name.toLowerCase() },
    "@/lib/local-cw": { listLocalCw: () => [], localCwSourceEnabled: () => true },
    "@/lib/continue-watching": { localToLibraryItem: (i: any) => i },
    "@/lib/cw-anime-episode": {},
  };
  const seriesSource = readFileSync("src/lib/series-episodes.ts", "utf8");
  const parsed = ts.createSourceFile("series.ts", seriesSource, ts.ScriptTarget.Latest, true);
  const nextFn = parsed.statements.find(
    (node: any) => ts.isFunctionDeclaration(node) && node.name?.text === "nextUnwatchedAfter",
  )!;
  mocks["@/lib/series-episodes"] = {
    ...compile(
      "",
      () => {
        throw new Error("unexpected dependency");
      },
      nextFn.getText(parsed),
    ),
    fetchEpisodeList: async (meta: any) => {
      episodeReads++;
      readIds.push(meta.id);
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        if (episodeGate) await episodeGate;
        if (metadataFails) throw new Error("metadata offline");
        return episodes;
      } finally {
        activeReads--;
      }
    },
    fetchAdjacentEpisodes: async (_meta: any, cur: any) => {
      episodeReads++;
      if (metadataFails) throw new Error("metadata offline");
      const idx = episodes.findIndex((e) => e.season === cur.season && e.episode === cur.episode);
      return { next: idx < 0 ? null : (episodes[idx + 1] ?? null) };
    },
  };
  // The hook's persistent CW list wrapper is tested independently. These
  // advancement tests retain direct control over metadata timing and failures.
  mocks["@/lib/cw-episode-list-cache"] = {
    cwEpisodeListCacheToken: () => "test-cache-generation",
    cwEpisodeListCacheTtl: () => 12 * 60 * 60_000,
    fetchCachedCwEpisodeList: (meta: any, opts: any) =>
      mocks["@/lib/series-episodes"].fetchEpisodeList(meta, { ...opts, requireComplete: true }),
  };
  const load = (name: string): any => {
    if (name in mocks) return mocks[name];
    if (name === "./anime-detect") return mocks["@/lib/anime-detect"];
    if (name === "@/lib/cw-derived-caches") return { cwCacheOwnerKey: () => "test-owner" };
    assert.ok(name.startsWith("@/"), `unexpected import ${name}`);
    if (!modules.has(name))
      modules.set(
        name,
        compile(`src/${name.slice(2)}.ts`, load, undefined, events, persistentStorage),
      );
    return modules.get(name);
  };
  const { useCwAdvance } = load("@/views/home/hooks/use-cw-advance");
  const render = () => {
    stateSlot = refSlot = effectSlot = 0;
    dirty = false;
    const out = useCwAdvance(...params);
    pending.splice(0).forEach((fn) => fn());
    return out;
  };
  return {
    events,
    resumes,
    manual,
    dismissed,
    lastPlayed,
    setRemote: (value: any) => {
      remote = value;
    },
    setPrivate: (value: boolean) => {
      settings = { ...settings, cwPerProfile: value };
    },
    setSource: (value: boolean) => {
      settings = { ...settings, cwSources: { simkl: value } };
    },
    setSession: (value: object | null) => {
      session = value;
    },
    setProfile: (id: string) => {
      profile = { id };
    },
    setEpisodes: (value: any[]) => {
      episodes = value;
    },
    failMetadata: (value = true) => {
      metadataFails = value;
    },
    render: (...args: any[]) => {
      if (args.length) params = args;
      return render();
    },
    async flush() {
      let out: any[] = [];
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        if (dirty || i === 0) out = render();
      }
      return out;
    },
    get remoteReads() {
      return remoteReads;
    },
    get episodeReads() {
      return episodeReads;
    },
    get maxActiveReads() {
      return maxActiveReads;
    },
    get activeReads() {
      return activeReads;
    },
    get resolverReads() {
      return resolverReads;
    },
    get readIds() {
      return readIds.slice();
    },
    setNuvioAccount(id: string | null) {
      nuvioAccount = id;
    },
    setGate(gate: Promise<void> | null) {
      episodeGate = gate;
    },
    setResolverGate(gate: Promise<void> | null) {
      resolverGate = gate;
    },
    failResolver(value = true) {
      resolverFails = value;
    },
  };
}

test("remote completion advances an old pause and skips following remotely watched episodes", async () => {
  const h = harness();
  h.setRemote(progress([1, 2, 3]));
  h.render([item()], "", true);
  const [out] = await h.flush();
  assert.equal(out.state.episode, 4);
  assert.equal(out.upNext, true);
  assert.equal(out.state.timeOffset, 0);
});

test("incoming completed history creates a new card while Home stays open without paused sessions", async () => {
  const h = harness();
  h.setRemote(progress([], "tt100"));
  h.render([], "", true, []);
  assert.deepEqual(await h.flush(), []);
  h.setRemote(progress([1], "tt100", [anchor()]));
  h.events.poll();
  const out = await h.flush();
  assert.equal(out[0]._id, "tt100");
  assert.equal(out[0].state.episode, 2);
  assert.equal(out[0].upNext, true);
  assert.equal(h.remoteReads, 2);
});

test("returning focus refreshes watched progress before the next poll", async () => {
  const h = harness();
  h.setRemote(progress([]));
  h.render([item()], "", true);
  assert.equal((await h.flush())[0].state.episode, 1);
  h.setRemote(progress([1]));
  h.events.focus();
  assert.equal((await h.flush())[0].state.episode, 2);
});

test("newer local and remote rewatches remain on the current episode", async () => {
  for (const local of [false, true]) {
    const h = harness();
    const current = local ? item() : item(1, iso(1000));
    if (local) h.resumes.set("tt100:1:1", { ms: 60000, t: now + 1000 });
    h.render([current], "", true);
    assert.equal((await h.flush())[0], current);
    assert.equal(h.episodeReads, 0);
  }
});

test("an imported resume's fetch timestamp does not defeat remote completion", async () => {
  const h = harness();
  h.resumes.set("tt100:1:1", { ms: 300000, t: now + 1000, source: "simkl" });
  h.render([item()], "", true);
  assert.equal((await h.flush())[0].state.episode, 2);
});

test("manual unwatched overrides remote completion and synthetic finished anchors", async () => {
  for (const hasPause of [false, true]) {
    const h = harness();
    h.manual.set("tt100:1:1", false);
    h.setRemote(progress([1], "tt100", [anchor()]));
    h.render(hasPause ? [item()] : [], "", true, []);
    const out = await h.flush();
    assert.equal(out.length, hasPause ? 1 : 0);
    if (hasPause) assert.equal(out[0].state.episode, 1);
    assert.equal(h.episodeReads, 0);
  }
});

test("private profiles, disabled CW sources, disconnected sessions and disabled advancement do not read remote history", async () => {
  for (const mode of ["private", "source", "session", "disabled"]) {
    const h = harness();
    if (mode === "private") h.setPrivate(true);
    if (mode === "source") h.setSource(false);
    if (mode === "session") h.setSession(null);
    const current = item();
    h.render([current], "", mode !== "disabled");
    assert.equal((await h.flush())[0], current);
    assert.equal(h.remoteReads, 0);
  }
});

test("caught-up remote completion removes the stale pause but metadata failure preserves it", async () => {
  const h = harness();
  h.setRemote(progress([1, 2, 3, 4]));
  h.render([item()], "", true);
  assert.deepEqual(await h.flush(), []);
  const failed = harness(),
    current = item();
  failed.failMetadata();
  failed.render([current], "", true);
  assert.equal((await failed.flush())[0], current);
  failed.failMetadata(false);
  failed.render([current], "", true);
  assert.equal((await failed.flush())[0].state.episode, 2);
});

test("future and unknown anime episodes are not presented as playable up next", async () => {
  for (const airDate of ["2099-01-01", undefined]) {
    const h = harness();
    h.setRemote(progress([1], "mal:1"));
    h.setEpisodes([
      { season: 1, episode: 1, airDate: "2020-01-01" },
      { season: 1, episode: 2, airDate },
    ]);
    h.render([item(1, iso(-3600000), "mal:1")], "", true);
    assert.equal((await h.flush())[0]?.upNext, undefined);
  }
});

test("finished Psycho-Pass 2 is not shown as a resume while its final episode is checked", async () => {
  const h = harness();
  const source = {
    ...item(11, iso(-3600000), "anilist:20513"),
    name: "Psycho-Pass 2",
    local: true,
    state: {
      ...item(11, iso(-3600000), "anilist:20513").state,
      season: 2,
      episode: 11,
      video_id: "kitsu:7863:11",
      timeOffset: 1_316_899,
      duration: 1_341_385,
      flaggedWatched: 1,
    },
  };
  h.setEpisodes([{ season: 2, episode: 11, airDate: "2014-12-18" }]);
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    assert.deepEqual(
      h.render([source], "", true, []),
      [],
      "the finished S2 E11 source flashed as a 0m-left resume before metadata resolved",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      h.readIds.includes(source._id),
      "hiding a completed checkpoint must not prevent checking for the next episode",
    );
  } finally {
    release();
  }
  assert.deepEqual(await h.flush(), [], "caught-up Psycho-Pass reappeared after reconciliation");
});

test("completed sources are hidden while pending, then yield their verified next episode", async () => {
  const h = harness();
  const source = {
    ...item(1, iso(-3600000), "ttPsychoNext"),
    state: {
      ...item(1, iso(-3600000), "ttPsychoNext").state,
      timeOffset: 1_316_899,
      duration: 1_341_385,
      flaggedWatched: 1,
    },
  };
  h.setEpisodes([1, 2].map((episode) => ({ season: 1, episode, airDate: "2020-01-01" })));
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    assert.deepEqual(
      h.render([source], "", true, []),
      [],
      "a completed source was shown before its successor was verified",
    );
  } finally {
    release();
  }
  const after = await h.flush();
  assert.equal(after.length, 1, "the legitimate next episode was hidden with its source");
  assert.equal(after[0].state.episode, 2);
  assert.equal(after[0].upNext, true);
});

test("in-progress and manually unwatched checkpoints remain visible without metadata", async () => {
  const h = harness();
  const id = "ttPsychoManual";
  const partial = item(1, iso(-3600000), id);
  const finished = {
    ...partial,
    state: {
      ...partial.state,
      timeOffset: 1_316_899,
      duration: 1_341_385,
      flaggedWatched: 1,
    },
  };
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    assert.equal(h.render([partial], "", true, [partial])[0]?._id, id);
    h.manual.set(`${id}:1:1`, false);
    assert.equal(
      h.render([finished], "", true, [finished])[0]?._id,
      id,
      "an explicit manual unwatched override must not be hidden",
    );
  } finally {
    release();
  }
  await h.flush();
});

test("local completion does not wait for a slow history request", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.render([anchor()], "", true);
  assert.equal((await h.flush())[0].state.episode, 2);
});

test("unowned parent maps cannot skip episodes while the current account is loading", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.render(
    [anchor()],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map([["tt100", new Set(["1:1", "1:2", "1:3"])]]),
  );
  assert.equal((await h.flush())[0].state.episode, 2);
});
test("series with completed season advances to season 2 episode 1 when season 1 episode exceeds season max", async () => {
  const h = harness();
  h.setRemote(progress([10], "ttMobland"));
  h.setEpisodes([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ep) => ({
      season: 1,
      episode: ep,
      airDate: "2020-01-01",
    })),
    { season: 2, episode: 1, airDate: "2021-01-01" },
  ]);
  const mobland = {
    ...item(11, iso(), "ttMobland"),
    upNext: true,
    state: { ...item(11, iso(), "ttMobland").state, season: 1, episode: 11, timeOffset: 0 },
  };
  h.render([mobland], "", true);
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].state.season, 2);
  assert.equal(out[0].state.episode, 1);
});

test("series with completed season is removed when no subsequent seasons exist", async () => {
  const h = harness();
  h.setRemote(progress([10], "ttMoblandSingleSeason"));
  h.setEpisodes(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ep) => ({
      season: 1,
      episode: ep,
      airDate: "2020-01-01",
    })),
  );
  const mobland = {
    ...item(11, iso(), "ttMoblandSingleSeason"),
    upNext: true,
    state: {
      ...item(11, iso(), "ttMoblandSingleSeason").state,
      season: 1,
      episode: 11,
      timeOffset: 0,
    },
  };
  h.render([mobland], "", true);
  const out = await h.flush();
  assert.equal(out.length, 0);
});

test("independent episode-list requests overlap with a bounded concurrency of 3", async () => {
  const h = harness();
  const ids = ["tt210", "tt211", "tt212", "tt213", "tt214", "tt215"];
  const items = ids.map((id) => ({ ...item(1, iso(-3600000), id), upNext: true }));
  const watched = new Map(ids.map((id) => [id, new Set(["1:1"])]));
  h.setRemote({
    statuses: new Map(ids.map((id) => [id, "watching"])),
    watched,
    watchedAt: new Map(ids.map((id) => [id, new Map([["1:1", now]])])),
    completedSeries: [],
  });
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  h.render(items, "", true, []);
  for (let tick = 0; tick < 30 && h.activeReads < 3; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    h.render();
  }
  assert.equal(h.activeReads, 3);
  assert.equal(h.maxActiveReads, 3);
  release();
  h.setGate(null);
  await h.flush();
  assert.equal(h.episodeReads, ids.length);
  assert.ok(h.maxActiveReads <= 3, `saw ${h.maxActiveReads} concurrent reads`);
});

test("a rerun with unchanged entries reuses pass decisions without refetching", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  h.render([item(1)], "", true, []);
  await h.flush();
  const reads = h.episodeReads;
  assert.ok(reads > 0);
  // Same contents, new array/object identities: this is exactly what the pass
  // writing its own results produces.
  h.render([{ ...item(1) }], "", true, []);
  await h.flush();
  assert.equal(h.episodeReads, reads);
});

test("an unavailable anime resolver is not retried by every pass", async () => {
  const h = harness();
  h.failResolver();
  h.setRemote(progress([1, 2, 3, 4]));
  const played = item(5);
  const current = {
    ...played,
    upNext: true,
    state: { ...played.state, timeOffset: 0 },
  };
  h.render([current], "", true, []);
  const out = await h.flush();
  assert.equal(h.resolverReads, 1);
  assert.equal(out[0]?.state.episode, 5);
  assert.notEqual(out[0]?.removed, true);
  h.render([{ ...current }], "", true, []);
  await h.flush();
  assert.equal(h.resolverReads, 1);
});

test("a delayed resolver failure from the previous account cannot cool down the new account", async () => {
  const h = harness();
  h.failResolver();
  h.setRemote(progress([1, 2, 3, 4]));
  const played = item(5);
  const current = {
    ...played,
    upNext: true,
    state: { ...played.state, timeOffset: 0 },
  };
  h.setNuvioAccount("acct-a");
  let release: () => void = () => {};
  h.setResolverGate(new Promise<void>((resolve) => (release = resolve)));
  h.render([current], "", true, []);
  for (let tick = 0; tick < 30 && h.resolverReads < 1; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    h.render();
  }
  assert.equal(h.resolverReads, 1);
  // Owner A's resolver is still in flight when the account switches.
  h.setNuvioAccount("acct-b");
  h.render([current], "", true, []);
  release();
  h.setResolverGate(null);
  await h.flush();
  assert.equal(h.resolverReads, 2, "the new account obeyed the previous account's cooldown");
});

test("queued episode-list requests stop when the owner aborts", async () => {
  const h = harness();
  const ids = ["tt220", "tt221", "tt222", "tt223", "tt224"];
  const items = ids.map((id) => ({ ...item(1, iso(-3600000), id), upNext: true }));
  h.setRemote({
    statuses: new Map(ids.map((id) => [id, "watching"])),
    watched: new Map(ids.map((id) => [id, new Set(["1:1"])])),
    watchedAt: new Map(ids.map((id) => [id, new Map([["1:1", now]])])),
    completedSeries: [],
  });
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  h.render(items, "", true, []);
  for (let tick = 0; tick < 30 && h.activeReads < 3; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    h.render();
  }
  h.render(items, "", false, []);
  release();
  await h.flush();
  assert.ok(h.episodeReads <= 3, `started ${h.episodeReads} requests after abort`);
});

test("an owner switch invalidates completed episode lists", async () => {
  const h = harness();
  h.setPrivate(true);
  const played = item(1);
  const current = { ...played, upNext: true, state: { ...played.state, timeOffset: 0 } };
  h.render([current], "", true, []);
  await h.flush();
  const before = h.episodeReads;
  assert.ok(before > 0);
  h.setProfile("b");
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-01" },
    { season: 1, episode: 3, airDate: "2020-01-01" },
  ]);
  h.render([{ ...current }], "", true, []);
  await h.flush();
  assert.ok(h.episodeReads > before, "profile B reused profile A's cached list");
});

test("a superseded pass stops queueing and the replacement reuses started requests", async () => {
  const h = harness();
  const ids = ["tt230", "tt231", "tt232", "tt233", "tt234", "tt235"];
  const items = ids.map((id) => ({ ...item(1, iso(-3600000), id), upNext: true }));
  h.setRemote({
    statuses: new Map(ids.map((id) => [id, "watching"])),
    watched: new Map(ids.map((id) => [id, new Set(["1:1"])])),
    watchedAt: new Map(ids.map((id) => [id, new Map([["1:1", now]])])),
    completedSeries: [],
  });
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  h.render(items, "", true, [], "all", 0);
  for (let tick = 0; tick < 30 && h.activeReads < 3; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    h.render();
  }
  assert.equal(h.activeReads, 3);
  // New inputs arrive while the first three requests are still gated.
  h.render(items, "", true, [], "all", 1);
  release();
  h.setGate(null);
  await h.flush();
  const read = h.readIds;
  assert.equal(new Set(read).size, read.length, `refetched: ${read.join(",")}`);
  assert.equal(read.length, ids.length);
});

test("a Nuvio account change on the same slot invalidates cached CW work", async () => {
  const h = harness();
  const played = item(1);
  const current = { ...played, upNext: true, state: { ...played.state, timeOffset: 0 } };
  h.setNuvioAccount("acct-a");
  h.render([current], "", true, []);
  await h.flush();
  const before = h.episodeReads;
  assert.ok(before > 0);
  h.setNuvioAccount("acct-b");
  h.render([{ ...current }], "", true, []);
  await h.flush();
  assert.ok(h.episodeReads > before, "same-slot account switch reused the previous cache");
});

test("a finished temporary JoJo source advances to E8 without showing its already-watched E7", async () => {
  const h = harness();
  const id = "tt2359704";
  h.setRemote(progress([7], id));
  h.setEpisodes([
    { season: 6, episode: 7, airDate: "2020-01-01" },
    { season: 6, episode: 8, airDate: "2020-01-08" },
  ]);
  const stale = {
    ...item(7, iso(-3600000), id),
    name: "Steel Ball Run: JoJo's Bizarre Adventure",
    removed: true,
    temp: true,
    state: {
      ...item(7, iso(-3600000), id).state,
      season: 0,
      episode: 0,
      video_id: `${id}:6:7`,
      timeOffset: 1_496_078,
      duration: 1_504_171,
      flaggedWatched: 1,
    },
  };
  let release: () => void = () => {};
  h.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    assert.deepEqual(h.render([stale], "", true, []), [], "stale E7 flashed before the worker");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.readIds.includes(id), "the hidden source was not sent to episode advancement");
  } finally {
    release();
  }
  const out = await h.flush();
  assert.equal(out.length, 1, "a valid next episode was lost");
  assert.equal(out[0]._id, id);
  assert.equal(out[0].state.season, 6);
  assert.equal(out[0].state.episode, 8);
  assert.equal(out[0].upNext, true);
});

test("a paused episode waits for live completion evidence before advancing", async () => {
  const storage = new Map<string, string>();
  const initial = harness(storage);
  initial.setRemote(progress([1, 2, 3]));
  const source = item(1);
  initial.render([source], "", true, []);
  const [settled] = await initial.flush();
  assert.equal(settled?.state?.episode, 4);
  assert.equal(settled?.upNext, true);

  const reopened = harness(storage);
  reopened.setRemote(progress([1, 2, 3]));
  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const immediately = reopened.render([{ ...source }], "", true, []);
    assert.equal(immediately[0]?.state?.episode, 1);
    assert.equal(immediately[0]?.upNext, undefined);
  } finally {
    release();
  }
  const [confirmed] = await reopened.flush();
  assert.equal(confirmed?.state?.episode, 4);
});

test("live Black Clover advancement preserves verified provider S2 coordinates across reopening", async () => {
  const storage = new Map<string, string>();
  const source = anchor(3, "mal:61967");
  const original = harness(storage);
  original.setRemote(progress([3], source._id));
  original.setEpisodes(
    [1, 2, 3, 4].map((episode) => ({
      season: 1,
      episode,
      imdbSeason: 2,
      imdbEpisode: episode,
      airDate: "2020-01-01",
      kitsuStreamId: "kitsu:50024:" + episode,
    })),
  );
  original.render([source], "", true, []);
  const [verified] = await original.flush();
  assert.equal(verified?.state?.season, 1, "native playback remains entry-relative");
  assert.equal(verified?.state?.episode, 4);
  assert.deepEqual(verified?.cwVerifiedProviderMapping, {
    imdbSeason: 2,
    imdbEpisode: 4,
  });

  const reopened = harness(storage);
  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const [provisional] = reopened.render([{ ...source }], "", true, []);
    assert.equal(provisional?.state?.episode, 4);
    assert.equal(provisional?.state?.season, 1);
    assert.deepEqual(provisional?.cwVerifiedProviderMapping, {
      imdbSeason: 2,
      imdbEpisode: 4,
    });
  } finally {
    release();
  }
  await reopened.flush();
});
test("a partial live row still replays Black Clover's verified E4 when Simkl arrives late", async () => {
  const storage = new Map<string, string>();
  const source = anchor(3, "mal:61967");
  const other = item(1, iso(-3600000), "tt-other");
  const original = harness(storage);
  original.setRemote(progress([3], "mal:61967"));
  original.render([source], "", true, []);
  const [verified] = await original.flush();
  assert.equal(verified?.state?.episode, 4);
  assert.equal(verified?.upNext, true);

  // The rest of Home hydrates and completes a live pass without the Simkl
  // anime source. That must not overwrite or disable its last verified E4.
  const reopened = harness(storage);
  reopened.setRemote(progress([3], "mal:61967"));
  reopened.render([other], "", true, []);
  await reopened.flush();
  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const early = reopened.render([other, { ...source }], "", true, []);
    assert.equal(
      early.find((card: any) => card._id === source._id)?.state.episode,
      4,
      "Simkl E3 flashed after an unrelated live pass already finished",
    );
    assert.equal(early.find((card: any) => card._id === source._id)?.upNext, true);

    const changed = {
      ...source,
      state: { ...source.state, episode: 4, video_id: "mal:61967:1:4" },
    };
    const fresh = reopened.render([other, changed], "", true, []);
    assert.equal(
      fresh.find((card: any) => card._id === source._id)?.state.episode,
      4,
      "new source checkpoints must not reuse the older snapshot",
    );
  } finally {
    release();
  }
  await reopened.flush();
});

test("a definitive live no-next result retires a cached episode advancement", async () => {
  const storage = new Map<string, string>();
  const source = anchor(3, "mal:61967");
  const original = harness(storage);
  original.setRemote(progress([3], "mal:61967"));
  original.render([source], "", true, []);
  const [verified] = await original.flush();
  assert.equal(verified?.state?.episode, 4);

  const reopened = harness(storage);
  reopened.setRemote(progress([3], "mal:61967"));
  reopened.setEpisodes(
    [1, 2, 3].map((episode) => ({
      season: 1,
      episode,
      airDate: "2020-01-01",
    })),
  );
  const provisional = reopened.render([{ ...source }], "", true, []);
  assert.equal(provisional[0]?.state?.episode, 4);
  const live = await reopened.flush();
  assert.equal(
    live.some((card: any) => card._id === source._id),
    false,
    "a successfully verified caught-up series must not keep its old saved E4",
  );
});

test("late Simkl session hydration can replay only its own verified E4 checkpoint", async () => {
  const storage = new Map<string, string>();
  const blackClover = anchor(3, "mal:61967");
  const seed = harness(storage);
  seed.setRemote(progress([3], blackClover._id));
  seed.render([blackClover], "", true, []);
  assert.equal((await seed.flush())[0]?.state.episode, 4);

  const reopened = harness(storage);
  reopened.setSession(null);
  reopened.render([item(1, iso(-3600000), "tt-other")], "", true, []);
  await reopened.flush();
  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    reopened.setSession({ username: "fixture" });
    reopened.setRemote(progress([3], blackClover._id));
    const early = reopened.render([{ ...blackClover }], "", true, []);
    assert.equal(
      early[0]?.state?.episode,
      4,
      "late account hydration displayed the already-watched E3 despite a scoped proof",
    );
    assert.equal(early[0]?.upNext, true);
  } finally {
    release();
  }
  assert.equal((await reopened.flush())[0]?.state.episode, 4);
});
test("Phase 4C refuses a saved decision after a same-slot Nuvio account change", async () => {
  const storage = new Map<string, string>();
  const first = harness(storage);
  first.setNuvioAccount("account-a");
  first.setRemote(progress([1, 2, 3]));
  const source = item(1);
  first.render([source], "", true, []);
  const [settled] = await first.flush();
  assert.equal(settled?.state?.episode, 4);
  assert.ok(storage.size > 0);

  const second = harness(storage);
  second.setNuvioAccount("account-b");
  let release: () => void = () => {};
  second.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const immediately = second.render([{ ...source }], "", true, []);
    assert.equal(immediately[0]?.state?.episode, 1, "another account reused an old checkpoint");
  } finally {
    release();
  }
  await second.flush();
});

test("Phase 4C restores a proven resurfaced next-up card before its recheck", async () => {
  const storage = new Map<string, string>();
  const finished = anchor(1, "tt200");
  const original = harness(storage);
  original.setRemote(progress([1], "tt200"));
  original.render([], "", true, [finished]);
  const confirmed = await original.flush();
  assert.ok(confirmed.some((entry: any) => entry._id === "tt200" && entry.upNext === true));
  assert.ok(storage.size > 0, "resurface decision was not saved");

  const reopened = harness(storage);
  reopened.setRemote(progress([1], "tt200"));
  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const immediately = reopened.render([], "", true, [{ ...finished }]);
    assert.ok(immediately.some((entry: any) => entry._id === "tt200" && entry.upNext === true));
    assert.equal(immediately.find((entry: any) => entry._id === "tt200")?.state?.episode, 2);
  } finally {
    release();
  }
  await reopened.flush();
});

test("Phase 4C keeps a validated snapshot through an empty startup hydration pass", async () => {
  const storage = new Map<string, string>();
  const source = anchor(1);
  const initial = harness(storage);
  initial.setRemote(progress([1, 2, 3]));
  initial.render([source], "", true, []);
  const [settled] = await initial.flush();
  assert.equal(settled?.state?.episode, 4);
  assert.ok(storage.size > 0);
  const before = [...storage.values()][0];

  const reopened = harness(storage);
  reopened.setRemote(progress([1, 2, 3]));
  reopened.render([], "", true, []);
  await reopened.flush();
  assert.equal([...storage.values()][0], before, "initial hydration erased the valid snapshot");

  let release: () => void = () => {};
  reopened.setGate(new Promise<void>((resolve) => (release = resolve)));
  try {
    const immediately = reopened.render([{ ...source }], "", true, []);
    assert.equal(immediately[0]?.state?.episode, 4, "empty startup pass blocked restoration");
  } finally {
    release();
  }
  const [confirmed] = await reopened.flush();
  assert.equal(confirmed?.state?.episode, 4);
});

test("Rings of Power S3E1 completed under a library 0:0 placeholder advances to aired S3E2", async () => {
  const h = harness();
  const id = "tt7631058";
  h.setRemote(progress([], id));
  h.setEpisodes([
    { season: 3, episode: 1, airDate: "2026-11-11" },
    { season: 3, episode: 2, airDate: "2026-11-11" },
    { season: 3, episode: 3, airDate: "2026-11-11" },
  ]);
  const library = {
    ...item(1, iso(-120_000), id),
    name: "The Lord of the Rings: The Rings of Power",
    state: {
      ...item(1, iso(-120_000), id).state,
      season: 0, episode: 0,
      video_id: `${id}:3:1`, timeOffset: 4_410_208,
      duration: 4_413_504, flaggedWatched: 1,
    },
  };
  const local = {
    ...library, local: true,
    state: { ...library.state, season: 3, episode: 1 },
  };
  const merged = { ...library, cwMembers: [library, local] };
  h.render([merged], "", true, [merged, local]);
  const out = await h.flush();
  assert.equal(out.length, 1, "the completed series must still have a real next-up card");
  assert.equal(out[0].state.season, 3);
  assert.equal(out[0].state.episode, 2);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].state.timeOffset, 0);
});
