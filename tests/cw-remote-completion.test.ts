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
/** A locally finished card: hidden until a verified next episode/removal. */
const finishedLocal = (episode = 1, id = "tt300") => {
  const base = item(episode, iso(-3600000), id);
  return {
    ...base,
    state: { ...base.state, timeOffset: 1800000, duration: 1800000, flaggedWatched: 1 },
  };
};
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
) {
  const module = { exports: {} as any };
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", "window", "document", code)(
    require,
    module,
    module.exports,
    {
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  );
  return module.exports;
}

function harness() {
  const resumes = new Map<string, any>(),
    manual = new Map<string, boolean>();
  const lastPlayed = new Map<string, any>();
  const dismissed = new Set<string>();
  const unavailableIds = new Set<string>();
  let settings = { cwSources: { simkl: true }, cwHideCaughtUp: false, cwPerProfile: false };
  let profile = { id: "a" },
    session: object | null = { username: "fixture" };
  let remote: any = progress(),
    remoteReads = 0,
    episodeReads = 0,
    metadataFails = false;
  let episodes = [1, 2, 3, 4].map((episode) => ({ season: 1, episode, airDate: "2020-01-01" }));
  let entryEpisodes: any[] | null = null;
  let animeCwId: string | null = null;
  const entryLists = new Map<string, any[]>();
  let resolvedEntry: any = null;
  let resolverFails = false;
  let fetchGate: Promise<void> | null = null;
  let releaseFetchGate: (() => void) | null = null;
  const fetchSignals: Array<AbortSignal | undefined> = [];
  const fetchOptions: Array<any> = [];
  const advanceEvents: Array<{ name: string; [key: string]: any }> = [];
  let passSeq = 0;
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
      getAnimeCwId: () => animeCwId,
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
    "@/lib/cw-instrumentation": {
      cwAdvanceStart: () => {
        const pass = ++passSeq;
        advanceEvents.push({ name: "start", pass });
        return pass;
      },
      cwAdvanceComplete: (pass: number) => advanceEvents.push({ name: "complete", pass }),
      cwAdvanceSuperseded: (pass: number) => advanceEvents.push({ name: "superseded", pass }),
      cwAdvanceTerminate: (pass: number, outcome: string) =>
        advanceEvents.push({ name: "terminate", pass, outcome }),
      cwAdvanceCandidates: (ids: string[], pass: number) =>
        advanceEvents.push({ name: "candidates", ids, pass }),
      cwAdvanceOutcome: (id: string, outcome: string, pass: number) =>
        advanceEvents.push({ name: "outcome", id, outcome, pass }),
      cwAdvanceRequestStart: () => performance.now(),
      cwAdvanceRequestEnd: (...args: any[]) => advanceEvents.push({ name: "request", args }),
      cwStateCommit: (detail: any, pass: number) =>
        advanceEvents.push({ name: "commit", detail, pass }),
      cwStaleStart: (pass: number) => advanceEvents.push({ name: "staleStart", pass }),
      cwStaleComplete: (pass: number) => advanceEvents.push({ name: "staleComplete", pass }),
      cwResurfaceStart: (pass: number) => advanceEvents.push({ name: "resurfaceStart", pass }),
      cwResurfaceComplete: (pass: number) =>
        advanceEvents.push({ name: "resurfaceComplete", pass }),
      cwAnimeWarmStart: () => advanceEvents.push({ name: "warmStart" }),
      cwAnimeWarmEnd: () => advanceEvents.push({ name: "warmEnd" }),
    },
    "@/lib/providers/anime-franchise-root": { isSplitFranchiseKitsu: () => false },
    "@/lib/providers/kitsu": { parseKitsuId: () => null },
    "@/lib/providers/jikan": { franchiseDedupKey: (name: string) => name.toLowerCase() },
    "@/lib/local-cw": { listLocalCw: () => [], localCwSourceEnabled: () => true },
    "@/lib/continue-watching": { localToLibraryItem: (i: any) => i },
    "@/lib/cw-anime-episode": {},
    "@/lib/anime-tracker-entry": (() => {
      const resolve = async () => {
        if (resolverFails) throw new Error("resolver unavailable");
        return resolvedEntry;
      };
      return { resolveTrackerAnimeEntry: resolve, resolveTrackerAnimeEntryStrict: resolve };
    })(),
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
    fetchEpisodeList: async (meta: any, opts?: any) => {
      fetchSignals.push(opts?.signal);
      fetchOptions.push(opts);
      episodeReads++;
      if (fetchGate) await fetchGate;
      if (unavailableIds.has(meta?.id)) throw new Error("episode-list-unavailable");
      if (metadataFails) throw new Error("metadata offline");
      const anime = typeof meta?.id === "string" && /^(kitsu|mal|anilist|anidb):/.test(meta.id);
      if (anime && typeof meta.id === "string" && entryLists.has(meta.id))
        return entryLists.get(meta.id)!;
      return anime && entryEpisodes ? entryEpisodes : episodes;
    },
    fetchAdjacentEpisodes: async (_meta: any, cur: any) => {
      episodeReads++;
      if (metadataFails) throw new Error("metadata offline");
      const idx = episodes.findIndex((e) => e.season === cur.season && e.episode === cur.episode);
      return { next: idx < 0 ? null : (episodes[idx + 1] ?? null) };
    },
  };
  // This hook suite controls provider responses directly; persistence is
  // verified independently in the CW episode-list cache tests.
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
    if (!modules.has(name)) modules.set(name, compile(`src/${name.slice(2)}.ts`, load));
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
    resumes,
    manual,
    dismissed,
    lastPlayed,
    advanceEvents,
    fetchSignals,
    fetchOptions,
    holdFetch() {
      fetchGate = new Promise((resolve) => {
        releaseFetchGate = resolve;
      });
    },
    releaseFetch() {
      releaseFetchGate?.();
      releaseFetchGate = null;
      fetchGate = null;
    },
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
    setEntryEpisodes: (value: any[] | null) => {
      entryEpisodes = value;
    },
    setEntryList: (id: string, value: any[]) => {
      entryLists.set(id, value);
    },
    setResolvedEntry: (value: any) => {
      resolvedEntry = value;
    },
    setAnimeCwId: (value: string | null) => {
      animeCwId = value;
    },
    failMetadata: (value = true) => {
      metadataFails = value;
    },
    failResolveEntry: (value = true) => {
      resolverFails = value;
    },
    failFetchFor: (id: string) => {
      unavailableIds.add(id);
    },
    render: (...args: any[]) => {
      if (args.length) params = args;
      return render();
    },
    async flush() {
      let out: any[] = [];
      // A coalesced pass may start once more with newer inputs after the first
      // one commits, so allow more microtask turns than the old restart chain.
      for (let i = 0; i < 20; i++) {
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
  assert.equal(
    out.state.lastWatched,
    iso(0),
    "the advanced card must carry the remote completion time, not the old checkpoint",
  );
});

test("rapid input changes coalesce into one trailing pass with the latest items", async () => {
  const h = harness();
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  h.render([anchor(1, "tt102")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  h.render([anchor(1, "tt103")], "", true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);
  assert.equal(h.episodeReads, 1);

  h.releaseFetch();
  await h.flush();
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(
    h.advanceEvents.filter(
      (event) =>
        event.name === "complete" || event.name === "terminate" || event.name === "superseded",
    ).length,
    2,
  );
  assert.equal(h.advanceEvents.filter((event) => event.name === "superseded").length, 1);
  assert.equal(h.episodeReads, 2);
});

test("a same-owner input change prevents the older pass from committing", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));

  h.render([anchor(2, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  h.releaseFetch();
  const out = await h.flush();

  assert.equal(out[0].state.episode, 3);
  const starts = h.advanceEvents.filter((event) => event.name === "start");
  assert.equal(starts.length, 2);
  const commits = h.advanceEvents.filter(
    (event) => event.name === "commit" && typeof event.pass === "number",
  );
  assert.equal(commits.length, 1);
  assert.equal(commits[0].pass, starts[1].pass);
});

test("an owner change invalidates the active pass and starts a new one immediately", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  h.setProfile("b");
  h.render();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.ok(
    h.advanceEvents.some((event) => event.name === "terminate" && event.outcome === "cancelled"),
  );
  h.releaseFetch();
  await h.flush();
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(
    h.advanceEvents.filter((event) => event.name === "complete" || event.name === "terminate")
      .length,
    2,
  );
});

test("a provider configuration change starts a fresh pass and clears the old cache", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  const signal = h.fetchSignals[0];
  assert.ok(signal);

  h.render([anchor(1, "tt101")], "new-tmdb-key", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(h.episodeReads, 2);

  h.releaseFetch();
  await h.flush();
});

test("an owner change aborts the previous request signal", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  const signal = h.fetchSignals[0];
  assert.ok(signal);
  assert.equal(signal.aborted, false);

  h.setProfile("b");
  h.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);

  h.releaseFetch();
  await h.flush();
});

test("the worker deadline terminates a hanging pass", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  t.mock.timers.tick(30_000);
  const terminal = h.advanceEvents.find((event) => event.name === "terminate");
  assert.equal(terminal?.outcome, "timeout");
});

test("rapid input changes coalesce into one trailing pass with the latest items", async () => {
  const h = harness();
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  h.render([anchor(1, "tt102")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  h.render([anchor(1, "tt103")], "", true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);
  assert.equal(h.episodeReads, 1);

  h.releaseFetch();
  await h.flush();
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(
    h.advanceEvents.filter(
      (event) =>
        event.name === "complete" || event.name === "terminate" || event.name === "superseded",
    ).length,
    2,
  );
  assert.equal(h.advanceEvents.filter((event) => event.name === "superseded").length, 1);
  assert.equal(h.episodeReads, 2);
});

test("a same-owner input change prevents the older pass from committing", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));

  h.render([anchor(2, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  h.releaseFetch();
  const out = await h.flush();

  assert.equal(out[0].state.episode, 3);
  const starts = h.advanceEvents.filter((event) => event.name === "start");
  assert.equal(starts.length, 2);
  const commits = h.advanceEvents.filter(
    (event) => event.name === "commit" && typeof event.pass === "number",
  );
  assert.equal(commits.length, 1);
  assert.equal(commits[0].pass, starts[1].pass);
});

test("an owner change invalidates the active pass and starts a new one immediately", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  h.setProfile("b");
  h.render();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.ok(
    h.advanceEvents.some((event) => event.name === "terminate" && event.outcome === "cancelled"),
  );
  h.releaseFetch();
  await h.flush();
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(
    h.advanceEvents.filter((event) => event.name === "complete" || event.name === "terminate")
      .length,
    2,
  );
});

test("a provider configuration change starts a fresh pass and clears the old cache", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  const signal = h.fetchSignals[0];
  assert.ok(signal);

  h.render([anchor(1, "tt101")], "new-tmdb-key", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);
  assert.equal(h.episodeReads, 2);

  h.releaseFetch();
  await h.flush();
});

test("an owner change aborts the previous request signal", async () => {
  const h = harness();
  h.setRemote(new Promise(() => {}));
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  const signal = h.fetchSignals[0];
  assert.ok(signal);
  assert.equal(signal.aborted, false);

  h.setProfile("b");
  h.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 2);

  h.releaseFetch();
  await h.flush();
});

test("the worker deadline terminates a hanging pass", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.holdFetch();
  h.render([anchor(1, "tt101")], "", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.advanceEvents.filter((event) => event.name === "start").length, 1);

  t.mock.timers.tick(30_000);
  const terminal = h.advanceEvents.find((event) => event.name === "terminate");
  assert.equal(terminal?.outcome, "timeout");
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

test("manual unwatched survives a season-overflow caught-up decision", async () => {
  const h = harness();
  h.manual.set("tt100:1:11", false);
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    ...Array.from({ length: 10 }, (_, index) => ({
      season: 1,
      episode: index + 1,
      airDate: "2020-01-01",
    })),
    { season: 2, episode: 1, airDate: "2099-01-01" },
  ]);
  h.render(
    [anchor(11)],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].state.episode, 11);
  assert.equal(out[0].caughtUp, undefined);
  assert.equal(out[0].waitingForAir, undefined);
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

test("a finished session missing from playback imports resurfaces the next aired episode", async () => {
  const h = harness();
  h.setRemote(progress([1, 2], "tt100", [anchor(2)]));
  h.render([], "", true, []);
  const [out] = await h.flush();
  assert.equal(out._id, "tt100");
  assert.equal(out.state.episode, 3);
  assert.equal(out.upNext, true);
});

test("an older inactive library anchor is updated without losing identity or artwork", async () => {
  const h = harness(),
    existing = {
      ...anchor(1, "tmdb:tv:100"),
      poster: "fixture.jpg",
      _mtime: iso(-3600000),
      state: { ...anchor().state, lastWatched: iso(-3600000) },
    };
  const data = progress([1, 2], "tt100", [anchor(2)]);
  data.watchedAt.set(existing._id, data.watchedAt.get("tt100")!);
  data.watched.set(existing._id, data.watched.get("tt100")!);
  h.setRemote(data);
  h.render([], "", true, [existing]);
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0]._id, existing._id);
  assert.equal(out[0].poster, "fixture.jpg");
  assert.equal(out[0].state.episode, 3);
});

test("removed titles and newer active library entries are not replaced by history anchors", async () => {
  for (const existing of [{ ...item(), removed: true }, item(1, iso(1000))]) {
    const h = harness();
    h.setRemote(progress([1], "tt100", [anchor()]));
    h.render([], "", true, [existing]);
    assert.deepEqual(await h.flush(), []);
    assert.equal(h.episodeReads, 0);
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

test("a future season placeholder with no air date is not kept in timer mode", async () => {
  const h = harness();
  h.setRemote(progress([1, 2, 3], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-01" },
    { season: 1, episode: 3, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  h.render(
    [item(3)],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  assert.equal((await h.flush()).length, 0);
});

test("a future-dated next-season episode waits with its air date instead of becoming playable up next", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    ...Array.from({ length: 10 }, (_, index) => ({
      season: 1,
      episode: index + 1,
      airDate: "2020-01-01",
    })),
    { season: 2, episode: 1, airDate: "2099-01-01" },
  ]);
  h.render(
    [anchor(11)],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const [card] = await h.flush();
  assert.ok(card);
  assert.equal(card.state.season, 2);
  assert.equal(card.state.episode, 1);
  assert.equal(card.upNext, true);
  assert.equal(card.waitingForAir, true);
  assert.equal(card.nextAirDate, "2099-01-01");
});

// A just-started sequel season: the provider list only holds the S2E1
// placeholder, so the finished S2E2 is unplaceable and Cinemeta offers no next
// episode. The recorded anime entry knows the follow-up and must keep the card.
test("a sequel episode missing from the provider list waits for air via the recorded anime entry", async () => {
  // The air-tick scheduler uses window timers; "timer" mode is the first test to reach them.
  const g = globalThis as any;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = { setTimeout: () => 0, clearTimeout: () => {} };
  try {
    const h = harness();
    h.setRemote(progress([1], "tt100"));
    h.setEpisodes([
      { season: 1, episode: 1, airDate: "2020-01-01" },
      { season: 2, episode: 1 },
    ]);
    h.setAnimeCwId("kitsu:9");
    h.setEntryEpisodes([
      { season: 1, episode: 1, airDate: "2020-01-01" },
      { season: 1, episode: 2, airDate: "2020-01-08" },
      { season: 1, episode: 3, airDate: "2099-01-01" },
    ]);
    const finished = anchor(2, "tt100");
    finished.isAnime = true;
    finished.state = { ...finished.state, season: 2, episode: 2, video_id: "kitsu:9:2" };
    h.render(
      [finished],
      "",
      true,
      [],
      "all",
      0,
      new Set(),
      new Map(),
      new Map(),
      new Map(),
      0,
      false,
      "timer",
    );
    const out = await h.flush();
    assert.equal(out.length, 1);
    assert.equal(out[0].waitingForAir, true);
    assert.equal(out[0].nextAirDate, "2099-01-01");
    assert.equal(out[0].state.episode, 2);
  } finally {
    if (!hadWindow) delete g.window;
  }
});

test("an aired sequel episode missing from the provider list advances via the anime entry", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  h.setAnimeCwId("kitsu:9");
  h.setEntryEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-08" },
    { season: 1, episode: 3, airDate: "2020-01-15" },
  ]);
  const finished = anchor(2, "tt100");
  finished.isAnime = true;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "kitsu:9:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].state.season, 2);
  assert.equal(out[0].state.episode, 3);
  assert.equal(out[0].state.video_id, "tt100:2:3");
});

// The detail page records the parent (season 1) entry for an IMDb row, so the
// recorded entry's episodes all declare imdbSeason 1. Projecting a finished
// season-2 episode into that list returned a season-1 up-next; the follow-up
// must walk to the sequel cour that actually aired the season.
test("a season-1 recorded entry never answers a sequel season as season 1", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  h.setAnimeCwId("kitsu:9");
  h.setEntryList("kitsu:9", [
    {
      season: 1,
      episode: 1,
      imdbSeason: 1,
      imdbEpisode: 1,
      absoluteNumber: 1,
      airDate: "2020-01-01",
    },
    {
      season: 1,
      episode: 2,
      imdbSeason: 1,
      imdbEpisode: 2,
      absoluteNumber: 2,
      airDate: "2020-01-08",
    },
    {
      season: 1,
      episode: 3,
      imdbSeason: 1,
      imdbEpisode: 3,
      absoluteNumber: 3,
      airDate: "2020-01-15",
    },
    {
      season: 1,
      episode: 4,
      imdbSeason: 1,
      imdbEpisode: 4,
      absoluteNumber: 4,
      airDate: "2020-01-22",
    },
  ]);
  h.setEntryList("kitsu:9s2", [
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-08" },
    { season: 1, episode: 3, airDate: "2020-01-15" },
  ]);
  h.setResolvedEntry({ id: "kitsu:9s2", episode: 2, baseId: "kitsu:9" });
  const finished = anchor(2, "tt100");
  finished.isAnime = true;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tt100:2:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].upNext, true);
  assert.equal(
    out[0].state.season,
    2,
    "must stay in the provider season, not fall back to season 1",
  );
  assert.equal(out[0].state.episode, 3);
});

// A catalog row the app never flagged as anime (an IMDb/TMDB id with no
// detection or recorded mapping) still deserves the anime-entry follow-up when
// the provider list cannot place its finished episode.
test("an undetected catalog anime row still resolves the sequel cour", async () => {
  const h = harness();
  h.setRemote(progress([1], "tmdb:tv:100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  h.setAnimeCwId(null);
  h.setEntryList("kitsu:9s2", [
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-08" },
    { season: 1, episode: 3, airDate: "2020-01-15" },
  ]);
  h.setResolvedEntry({ id: "kitsu:9s2", episode: 2, baseId: "kitsu:49147" });
  const finished = anchor(2, "tmdb:tv:100");
  finished.isAnime = false;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tmdb:tv:100:2:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].state.season, 2);
  assert.equal(out[0].state.episode, 3);
});

// No anime entry is resolvable for this row, and the provider list does not
// know season 2 at all. The old scan-from-index-0 advanced such rows to an
// unrelated season-1 episode; it must show a neutral caught-up card instead.
test("an unplaceable anime row with no anime entry stays caught up instead of walking the provider list", async () => {
  const g = globalThis as any;
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = { setTimeout: () => 0, clearTimeout: () => {} };
  try {
    const h = harness();
    h.setRemote(progress([1], "tt100"));
    h.setEpisodes([
      { season: 1, episode: 1, airDate: "2020-01-01" },
      { season: 2, episode: 1 },
    ]);
    const finished = anchor(2, "tt100");
    finished.isAnime = true;
    finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tt100:2:2" };
    h.render(
      [finished],
      "",
      true,
      [],
      "all",
      0,
      new Set(),
      new Map(),
      new Map(),
      new Map(),
      0,
      false,
      "timer",
    );
    const out = await h.flush();
    assert.equal(out.length, 1);
    assert.equal(out[0].upNext, undefined);
    assert.equal(out[0].caughtUp, true);
    assert.equal(out[0].waitingForAir, undefined);
    assert.equal(out[0].nextAirDate, undefined);
    assert.equal(out[0].state.episode, 2);
  } finally {
    if (!hadWindow) delete g.window;
  }
});

test("an unplaceable anime row with no anime entry still drops in hide mode", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  const finished = anchor(2, "tt100");
  finished.isAnime = true;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tt100:2:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  assert.deepEqual(await h.flush(), []);
});

test("a finished local card stays visible when its episode list cannot be fetched", async () => {
  const h = harness();
  h.failFetchFor("tt300");
  h.render([finishedLocal(1, "tt300")], "", true);

  const out = await h.flush();

  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt300");
  assert.equal(out[0].state.episode, 1, "the last good finished card stays readable");
  assert.equal(out[0].upNext, undefined);
});

test("a finished local card stays visible when the episode list is empty", async () => {
  const h = harness();
  h.setEpisodes([]);
  h.render([finishedLocal(1, "tt301")], "", true);

  const out = await h.flush();

  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt301");
});

test("a later successful pass advances a finished card that failed earlier", async () => {
  const h = harness();
  const items = [finishedLocal(1, "tt302")];
  h.setEpisodes([]);
  h.render(items, "", true);
  assert.equal((await h.flush()).length, 1, "failure keeps the finished card visible");

  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 1, episode: 2, airDate: "2020-01-02" },
  ]);
  h.render([...items], "", true);
  const out = await h.flush();

  assert.equal(out[0]?.state.episode, 2);
  assert.equal(out[0]?.upNext, true);
});

test("a verified removal still hides a finished local card", async () => {
  const h = harness();
  h.setEpisodes([{ season: 1, episode: 1, airDate: "2020-01-01" }]);
  h.render([finishedLocal(1, "tt303")], "", true);

  const out = await h.flush();

  assert.equal(out.length, 0);
});

test("an unavailable episode list keeps the card instead of dropping it in hide mode", async () => {
  const h = harness();
  // The episode sources coerce an unreachable provider to []. That must not be
  // read as "the show has no episodes": the card stays and is marked retryable.
  h.setEpisodes([]);
  h.render(
    [anchor(1, "tt200")],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt200");
  assert.equal(out[0].upNext, undefined);
  // Advancement must ask the episode source to distinguish "no episodes" from
  // "the provider could not answer"; [] alone is what caused the removal bug.
  assert.ok(h.fetchOptions.length > 0);
  assert.ok(h.fetchOptions.every((opts) => opts?.requireComplete === true));
  const outcomes = h.advanceEvents.filter(
    (event) => event.name === "outcome" && event.id === "tt200",
  );
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every((event) => event.outcome === "failure"));
});

test("an episode-list lookup that throws keeps the card instead of dropping it", async () => {
  const h = harness();
  h.failFetchFor("tt201");
  h.render(
    [anchor(1, "tt201")],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt201");
  assert.ok(
    h.advanceEvents.some(
      (event) => event.name === "outcome" && event.id === "tt201" && event.outcome === "failure",
    ),
  );
});

test("an unavailable sequel list keeps the card instead of dropping it in hide mode", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 1, airDate: "2020-01-01" },
    { season: 2, episode: 1 },
  ]);
  h.setAnimeCwId("kitsu:999");
  // The sequel entry cannot be read right now. That is not proof the series is over.
  h.failFetchFor("kitsu:999");
  const finished = anchor(2, "tt100");
  finished.isAnime = true;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tt100:2:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt100");
  assert.ok(
    h.advanceEvents.some(
      (event) => event.name === "outcome" && event.id === "tt100" && event.outcome === "failure",
    ),
  );
});

test("an unavailable anime sequel resolver keeps the card in hide mode", async () => {
  const h = harness();
  // The provider list does not cover the row's season, so advancement asks the
  // resolver for a sequel. An unavailable resolver must not read as "series over".
  h.setEpisodes([{ season: 1, episode: 1, airDate: "2020-01-01" }]);
  h.failResolveEntry();
  const finished = anchor(2, "tt100");
  finished.isAnime = true;
  finished.state = { ...finished.state, season: 2, episode: 2, video_id: "tt100:2:2" };
  h.render(
    [finished],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "hide",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0]._id, "tt100");
  assert.ok(
    h.advanceEvents.some(
      (event) => event.name === "outcome" && event.id === "tt100" && event.outcome === "failure",
    ),
  );
});

test("a rerun over unchanged inputs completes without another state commit", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  h.render([item()], "", true);
  const [first] = await h.flush();
  const commits = () => h.advanceEvents.filter((event) => event.name === "commit").length;
  const baseline = commits();
  assert.ok(baseline >= 1);
  assert.equal(first.state.episode, 2);

  // A new array holding a semantically equal card is a real pass with an
  // equivalent result: it must complete without publishing state again.
  h.render([item()], "", true);
  const [second] = await h.flush();
  assert.equal(commits(), baseline);
  assert.equal(second.state.episode, 2);
});

test("a genuine progress change still commits", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  h.render([item()], "", true);
  await h.flush();
  const commits = () => h.advanceEvents.filter((event) => event.name === "commit").length;
  const baseline = commits();

  h.render([item(2)], "", true);
  await h.flush();
  assert.ok(commits() > baseline);
});

test("a nested CW member change still commits", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  const withMember = (episode: number) => {
    const base = item();
    Object.assign(base, {
      cwMembers: [{ ...base, _id: "tt900", state: { ...base.state, episode } }],
    });
    return base;
  };
  h.render([withMember(1)], "", true);
  await h.flush();
  const commits = () => h.advanceEvents.filter((event) => event.name === "commit").length;
  const baseline = commits();

  // Same member ids, different checkpoint: the group really changed.
  h.render([withMember(2)], "", true);
  await h.flush();
  assert.ok(commits() > baseline);
});

test("reconstructed but identical provider playback ids do not commit", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  const withIds = () => {
    const base = item();
    Object.assign(base, { providerPlaybackIds: { simkl: "play-1" } });
    return base;
  };
  h.render([withIds()], "", true);
  await h.flush();
  const commits = () => h.advanceEvents.filter((event) => event.name === "commit").length;
  const baseline = commits();

  // New objects, same values: nothing to publish.
  h.render([withIds()], "", true);
  await h.flush();
  assert.equal(commits(), baseline);
});

test("nested member source flags still commit", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  const withMember = (patch: Record<string, unknown>) => {
    const base = item();
    Object.assign(base, { cwMembers: [{ ...base, _id: "tt901", ...patch }] });
    return base;
  };
  h.render([withMember({ local: false, manualWatched: false })], "", true);
  await h.flush();
  const commits = () => h.advanceEvents.filter((event) => event.name === "commit").length;

  // `local` selects the dismissal scope when the member has no provider.
  let baseline = commits();
  h.render([withMember({ local: true, manualWatched: false })], "", true);
  await h.flush();
  assert.ok(commits() > baseline);

  baseline = commits();
  h.render([withMember({ local: true, manualWatched: true })], "", true);
  await h.flush();
  assert.ok(commits() > baseline);
});

test("a profile switch republishes an equivalent advancement result", async () => {
  const h = harness();
  h.setRemote(progress([1]));
  // One card object across both owners: the computed result is semantically
  // identical, so only the owner transition can force a publication.
  const card = item();
  h.render([card], "", true);
  const [first] = await h.flush();
  assert.equal(first.state.episode, 2);

  h.setProfile("b");
  h.render([card], "", true);
  const out = await h.flush();
  const second = out.find((entry) => entry._id === "tt100");
  // The new owner computes the same result, but it must still be published:
  // the owner reset is queued and the old result is no longer valid state.
  assert.ok(second);
  assert.equal(second.state.episode, 2);
});

test("a dismissed displayed episode stays hidden after advancement and resurfacing", async () => {
  for (const hasPause of [false, true]) {
    const h = harness();
    h.dismissed.add("tt100:1:2");
    h.setRemote(progress([1], "tt100", [anchor()]));
    h.render(hasPause ? [item()] : [], "", true, []);
    assert.deepEqual(await h.flush(), []);
  }
});

test("switching account, source or profile hides stored remote results immediately", async () => {
  for (const mode of ["session", "source", "profile"]) {
    const h = harness();
    h.setRemote(progress([1], "tt100", [anchor()]));
    h.render([], "", true, []);
    assert.equal((await h.flush()).length, 1);
    h.setRemote(progress([], "tt200"));
    if (mode === "session") h.setSession({ username: "second" });
    if (mode === "source") h.setSource(false);
    if (mode === "profile") h.setProfile("second");
    assert.deepEqual(h.render(), []);
    assert.deepEqual(await h.flush(), []);
  }
});

test("a delayed history response cannot update a later private profile", async () => {
  const h = harness();
  let release!: (value: any) => void;
  h.setRemote(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  h.render([item()], "", true);
  h.setProfile("second");
  h.setPrivate(true);
  const own = item(3);
  h.render([own], "", true);
  release(progress([1, 2], "tt100", [anchor(2)]));
  assert.deepEqual(await h.flush(), [own]);
  assert.equal(h.episodeReads, 0);
});

test("history failure does not prevent ordinary local completion advancement", async () => {
  const h = harness();
  h.setRemote(new Error("offline"));
  h.render([anchor()], "", true);
  assert.equal((await h.flush())[0].state.episode, 2);
});

test("failed metadata for history-only series is retried on the next refresh", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100", [anchor()]));
  h.failMetadata();
  h.render([], "", true, []);
  assert.deepEqual(await h.flush(), []);
  h.failMetadata(false);
  h.render([], "", true, []);
  assert.equal((await h.flush())[0]?.state.episode, 2);
});

test("manually unwatched inactive library entries are not resurfaced from a finished flag", async () => {
  const h = harness();
  h.manual.set("tt100:1:1", false);
  h.setRemote(progress([1], "tt100", [anchor()]));
  h.render([], "", true, [anchor()]);
  assert.deepEqual(await h.flush(), []);
});

test("history-only anchors cannot override a newer local rewatch of a different episode", async () => {
  const h = harness();
  h.setRemote(progress([1, 2, 3], "tt100", [anchor(3)]));
  h.lastPlayed.set("tt100", { season: 1, episode: 1, ms: 60000, t: now + 1000 });
  h.render([], "", true, []);
  assert.deepEqual(await h.flush(), []);
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

test("watched-dependent next episodes are recomputed after an account change", async () => {
  const h = harness();
  h.setRemote(progress([1, 2, 3], "tt100", [anchor()]));
  h.render([], "", true, []);
  assert.equal((await h.flush())[0].state.episode, 4);
  h.setSession({ username: "second" });
  h.setRemote(progress([1], "tt100", [anchor()]));
  h.render();
  assert.equal((await h.flush())[0].state.episode, 2);
});

const nuvioCard = (episode: number, extra: Record<string, unknown> = {}) => ({
  ...item(episode),
  external: "nuvio" as const,
  upNext: true,
  ...extra,
  state: {
    ...item(episode).state,
    timeOffset: 0,
    flaggedWatched: 0,
    ...(extra.state as Record<string, unknown> | undefined),
  },
});

test("an aired kept Nuvio card advances and clears its timer flags", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 10, airDate: "2020-01-01" },
    { season: 1, episode: 11, airDate: "2020-01-01" },
  ]);
  const card = nuvioCard(10, { keptForTimer: true, waitingForAir: true });
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].state.episode, 11);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].waitingForAir, undefined);
  assert.equal((out[0] as Record<string, unknown>).keptForTimer, undefined);
});

test("an unaired kept Nuvio card waits on the real next episode", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 10, airDate: "2020-01-01" },
    { season: 1, episode: 11, airDate: "2099-01-01" },
  ]);
  const card = nuvioCard(10, { keptForTimer: true, waitingForAir: true });
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].state.episode, 11);
  assert.equal(out[0].waitingForAir, true);
  assert.equal(out[0].nextAirDate, "2099-01-01");
});

test("manual-unwatched clears a kept card without advancing it", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.manual.set("tt100:1:10", false);
  h.setEpisodes([
    { season: 1, episode: 10, airDate: "2020-01-01" },
    { season: 1, episode: 11, airDate: "2020-01-01" },
  ]);
  const card = nuvioCard(10, { keptForTimer: true, waitingForAir: true });
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].state.episode, 10);
  assert.equal(out[0].waitingForAir, undefined);
  assert.equal((out[0] as Record<string, unknown>).keptForTimer, undefined);
});

test("a season-overflow Nuvio card advances to the next season", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    ...Array.from({ length: 10 }, (_, index) => ({
      season: 1,
      episode: index + 1,
      airDate: "2020-01-01",
    })),
    { season: 2, episode: 1, airDate: "2020-01-01" },
  ]);
  const card = nuvioCard(11, { keptForTimer: true });
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const out = await h.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].state.season, 2);
  assert.equal(out[0].state.episode, 1);
  assert.equal(out[0].upNext, true);
});

test("recomputing an aired kept card does not hop it forward again", async () => {
  const h = harness();
  h.setRemote(progress([1], "tt100"));
  h.setEpisodes([
    { season: 1, episode: 10, airDate: "2020-01-01" },
    { season: 1, episode: 11, airDate: "2020-01-01" },
    { season: 1, episode: 12, airDate: "2020-01-01" },
  ]);
  const card = nuvioCard(10, { keptForTimer: true, waitingForAir: true });
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    0,
    false,
    "timer",
  );
  const first = await h.flush();
  assert.equal(first[0].state.episode, 11);
  h.render(
    [card],
    "",
    true,
    [],
    "all",
    0,
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    1,
    false,
    "timer",
  );
  const second = await h.flush();
  assert.equal(second[0].state.episode, 11);
});

test("remote history follows existing recency, source status and request-count bounds", async () => {
  const h = harness();
  const data = progress([], "tt-empty");
  for (let n = 1; n <= 46; n++) {
    const id = `tt${n}`,
      value = anchor(1, id);
    value.name = `Series ${n}`;
    if (n === 44) value.state.lastWatched = new Date(now - 46 * 864e5).toISOString();
    data.completedSeries.push(value);
    data.statuses.set(id, n === 45 ? "dropped" : n === 46 ? "hold" : "watching");
    data.watched.set(id, new Set(["1:1"]));
    data.watchedAt.set(id, new Map([["1:1", now]]));
  }
  h.setRemote(data);
  h.render([], "", true, []);
  const out = await h.flush();
  assert.equal(out.length, 40);
  assert.equal(h.episodeReads, 40);
  assert.equal(
    out.some((i) => ["tt44", "tt45", "tt46"].includes(i._id)),
    false,
  );
});
