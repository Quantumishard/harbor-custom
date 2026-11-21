import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import * as icons from "lucide-react";
import { createRoot } from "react-dom/client";

function harness(
  actual: unknown = null,
  opts: {
    settings?: Record<string, unknown>;
    item?: Record<string, unknown>;
    seasonEpisodes?: unknown[];
  } = {},
) {
  const dom = new JSDOM("<!doctype html><body><div id='app'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const empty = () => {};
  let animeDetected = false;
  let detectionVersion = 0;
  let animeIds = 0;
  let animeCwId: string | null = null;
  let proof: string | null = null;
  let resolveVideo: (item: any, episode: any) => Promise<any> = async () => null;
  const videoCalls: any[] = [];
  const titleCalls: any[] = [];
  let titleValue: string | null | ((checkpoint: any) => string | null | Promise<string | null>) =
    null;
  let authKeyValue = "fixture-auth";
  let observerCallback: ((entries: any[]) => void) | null = null;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      constructor(callback: (entries: any[]) => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  let target: any;
  const starts: any[] = [];
  const removed: any[] = [];
  const playbackQueries: unknown[][] = [];
  const noopProvider = {
    pickEpisodeTitle: () => null,
    aniZipByAnidb: async () => null,
    aniZipByAnilist: async () => null,
    aniZipByKitsu: async () => null,
    aniZipByMal: async () => null,
  };
  const t = (key: string) => key;
  let profile = "fixture-a";
  const deps: Record<string, any> = {
    react: React,
    "react/jsx-runtime": jsx,
    "lucide-react": icons,
    "@/components/icons/play-filled": { Play: icons.Play },
    "@/lib/cinemeta": { narrowMediaType: (type: string) => type },
    "@/lib/meta-resource": { resolveMeta: async () => null },
    "@/lib/streams/playback-redirect": {
      isPlaybackRedirectCandidate: () => false,
      resolvePlaybackRedirect: async ({ url }: { url: string }) => url,
    },
    "@/lib/player/continue-playback": {
      continuationFor: (target: { id: string }) => ({ id: target.id }),
      canReuseRecentRemotePlayback: () => false,
    },
    "@/lib/resume": { readResumeEntry: () => null },
    "@/lib/providers/anime-kitsu-addon": { animeKitsuMeta: async () => null },
    "@/lib/providers/anime-franchise-root": { isSplitFranchiseKitsu: () => false },
    "@/lib/providers/kitsu": {
      parseKitsuId: (id: string) => {
        const match = /^kitsu:(\d+)/.exec(id ?? "");
        return match ? Number(match[1]) : null;
      },
    },
    "@/lib/streams/anime-identity-core": {
      isForeignSplitSeason: () => false,
      splitFranchiseDisplaySeason: () => undefined,
    },
    "@/lib/subtitles/anime-numbering": { classifyAnimeNumbering: () => ({ mode: "season" }) },
    "@/lib/providers/tmdb/tmdb-lite": { tmdbLiteMeta: async () => null },
    "@/lib/providers/tmdb": { tmdbIdFromImdb: async () => null },
    "@/lib/context-menu": {
      useContextMenu: () => ({
        open: (event: Event, value: any) => {
          event.preventDefault();
          event.stopPropagation();
          target = value;
        },
      }),
    },
    "@/lib/i18n": { useT: () => t },
    "@/lib/snapshots": { readSnapshot: () => null, useSnapshotVersion: empty },
    "@/lib/stremio": {
      episodeFromVideoId: () => null,
      isAnimeCwItem: () => false,
      libraryMetaType: (type: string) => type,
    },
    "@/lib/new-episodes": { useHasNewEpisode: () => 0 },
    "@/views/detail/tooltip": { Tooltip: ({ children }: any) => children },
    "@/lib/profiles": {
      useProfiles: () => ({ profiles: [], activeProfile: { id: profile } }),
      sharesStremioStorage: () => false,
    },
    "@/lib/auth": { useAuth: () => ({ authKey: authKeyValue }) },
    "@/lib/settings": {
      useSettings: () => ({ settings: { liquidGlass: false, ...opts.settings } }),
    },
    "@/lib/view": {
      useView: () => ({
        openMeta: (meta: any) => starts.push({ details: meta }),
        openPicker: (meta: any, episode: any, mode: any) => starts.push({ meta, episode, mode }),
        openPlayer: (src: any) => starts.push({ src }),
      }),
    },
    "@/lib/watched-by": { getWatchedBy: () => null },
    "@/lib/local-library/playback": { resolveLocalPlayVersions: () => [] },
    "@/lib/local-library/player-src": { localPlayerSrc: empty },
    "@/lib/player/local-versions-modal": { openLocalVersions: empty },
    "@/lib/media-server/connections": { mediaServerConnections: () => [] },
    "@/lib/media-server/index-store": { mediaServerItems: async () => [] },
    "@/lib/media-server/selectors": {
      matchingServerItems: () => [],
      serverPlayableCopies: () => [],
    },
    "@/lib/media-server/playback": {
      createMediaServerPlayerSrc: empty,
      decidePlaybackSource: () => ({ kind: "online" }),
    },
    "@/lib/series-episodes": { fetchSeasonEpisodes: async () => opts.seasonEpisodes ?? [] },
    "@/lib/providers/anizip": noopProvider,
    "@/lib/providers/anime-mapping": { animeMappingByKitsu: async () => null },
    "@/lib/logo": { peekCachedLogo: () => null, resolveLogo: async () => null },
    "@/lib/anime-title": {
      resolvePreferredAnimeTitle: async (id: string, lang: string, checkpoint: any) => {
        titleCalls.push({ id, lang, videoId: checkpoint?.videoId });
        return typeof titleValue === "function" ? titleValue(checkpoint) : titleValue;
      },
    },
    "@/lib/providers/jikan": { stripFranchiseSuffix: (name: string) => name },
    "@/lib/anime-cw-ids": {
      getAnimeCwId: () => animeCwId,
      animeCwIdsVersion: () => animeIds,
      subscribeAnimeCwIds: () => () => {},
      notifyAnimeCwIds: empty,
    },
    "@/lib/cw-card-coords": { rememberCardCoords: () => false },
    "@/lib/anime-detect": {
      isDetectedAnime: () => animeDetected,
      useDetectedAnimeVersion: () => detectionVersion,
    },
    "@/lib/cw-anime-identity": { provenCwAnimeIdentity: () => proof },
    "@/lib/streams/anime-identity": {
      resolveAnimeIdentity: async () =>
        assert.fail("ordinary series must not resolve anime identity"),
    },
    "@/lib/anime-tracker-entry": {
      resolveTrackerAnimeEntry: async () =>
        assert.fail("ordinary series must not resolve anime tracker identity"),
    },
    "@/lib/cw-anime-episode": {
      aniZipLookupKey: () => null,
      applyAniZipEpisode: empty,
      needsAniZipSyncIds: () => false,
      providerMappedEpisode: () => null,
    },
    "@/lib/cw-anime-video": {
      resolveCwAnimeVideo: async (entry: any, episode: any) => {
        videoCalls.push({ item: entry, episode });
        return resolveVideo(entry, episode);
      },
    },
    "@/components/ThreeLiquidGlassSurface": {
      ThreeLiquidGlassSurface: ({ children }: any) => children,
    },
    "@/components/lists/list-toast": { emitListToast: empty },
    "@/lib/playback-history": {
      capturePlaybackActor: () => profile,
      isPlaybackActorCurrent: (actor: string) => profile === actor,
      readActualPlaybackForTarget: (...args: unknown[]) => {
        playbackQueries.push(args);
        return actual;
      },
    },
    "@/lib/cw-dismiss": {
      isCwDismissed: (item: any) => removed.some((entry) => entry._id === item._id),
    },
    "@/lib/local-cw": { localCwEntry: () => ({}) },
    "@/lib/manual-watched": { isManualWatchedDismissed: () => false },
    "@/lib/active-profile-id": { isNuvioProviderActive: () => false },
  };
  const load = (path: string) => {
    const mod = { exports: {} as any };
    const output = ts.transpileModule(
      readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    new Function("require", "module", "exports", output)(
      (name: string) => {
        if (name === "@/lib/continue-card-actions") return load("src/lib/continue-card-actions.ts");
        if (name === "@/lib/cw-anime-play") return load("src/lib/cw-anime-play.ts");
        if (name.startsWith("@/assets/")) return "fixture-art";
        assert.ok(name in deps, `Unexpected dependency ${name}`);
        return deps[name];
      },
      mod,
      mod.exports,
    );
    return mod.exports;
  };
  const { ContinueCard } = load("src/components/continue-card.tsx");
  const root = createRoot(document.querySelector("#app")!);
  let item = opts.item ?? {
    _id: "older-b",
    type: "series",
    name: "Older B",
    state: { season: 2, episode: 3, video_id: "older-b:2:3", duration: 600000, timeOffset: 90000 },
  };
  const render = async () =>
    React.act(() =>
      root.render(
        jsx.jsx(ContinueCard, {
          item,
          onDismiss: (entry: any) => {
            removed.push(entry);
          },
        }),
      ),
    );
  return {
    starts,
    removed,
    playbackQueries,
    videoCalls,
    titleCalls,
    item,
    render,
    setItem(next: any) {
      item = next;
    },
    setAuthKey(value: string) {
      authKeyValue = value;
    },
    setTitleValue(
      value: string | null | ((checkpoint: any) => string | null | Promise<string | null>),
    ) {
      titleValue = value;
    },
    setAnimeDetected(value: boolean) {
      animeDetected = value;
    },
    bumpDetection() {
      detectionVersion += 1;
    },
    bumpAnimeIds() {
      animeIds += 1;
    },
    setAnimeCwId(value: string | null) {
      animeCwId = value;
    },
    setProof(value: string | null) {
      proof = value;
    },
    setResolveVideo(fn: (item: any, episode: any) => Promise<any>) {
      resolveVideo = fn;
    },
    async intersect() {
      await React.act(async () => {
        observerCallback?.([{ isIntersecting: true }]);
        await Promise.resolve();
      });
    },
    async flush() {
      await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    get target() {
      return target;
    },
    set profile(value: string) {
      profile = value;
    },
    async context(selector: string) {
      await React.act(() =>
        document
          .querySelector(selector)!
          .dispatchEvent(
            new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          ),
      );
    },
    async click(selector: string) {
      await React.act(async () => {
        document
          .querySelector(selector)!
          .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
    },
    async dispose() {
      await React.act(() => root.unmount());
      dom.window.close();
    },
  };
}

test("real ContinueCard keeps original playback while its menu groups sources and removal for the clicked entry", async () => {
  const h = harness();
  try {
    await h.render();
    await h.click("button[title='Choose another source']");
    assert.deepEqual(h.starts[0].mode, { autoPlay: false, resume: false });
    for (const selector of [
      "button[title='Choose another source']",
      "button[aria-label='Open details: Older B']",
      "button[title='Play']",
    ]) {
      await h.context(selector);
      assert.equal(h.target.meta.id, "older-b");
      assert.deepEqual(
        h.target.primary.actions().map((action: any) => action.label),
        ["Choose another source", "Remove from Continue Watching"],
      );
      assert.equal(h.target.extra, undefined, "removal is not duplicated below the title actions");
      await React.act(() => h.target.primary.actions()[0].run());
      const request = h.starts.at(-1);
      assert.equal(request.meta.id, "older-b");
      assert.deepEqual(request.episode, { season: 2, episode: 3 });
      assert.deepEqual(request.mode, { autoPlay: false, resume: false });
    }
    await h.click("button[title='Play']");
    assert.deepEqual(h.starts.at(-1).mode, { autoPlay: true, resume: true });
    await React.act(() => h.target.primary.actions()[1].run());
    assert.equal(h.removed[0], h.item);
    assert.equal(h.target.isValid(), false);
  } finally {
    await h.dispose();
  }
});

test("Play refreshes the saved release and Choose another source opens an independent picker", async () => {
  const h = harness({ id: "saved-aio", src: { streamRef: { infoHash: "saved-hash" } } });
  try {
    await h.render();
    await h.click("button[title='Play']");
    assert.deepEqual(h.starts.at(-1).mode, {
      autoPlay: true,
      resume: true,
      continuation: { id: "saved-aio" },
    });
    await h.click("button[title='Choose another source']");
    assert.deepEqual(h.starts.at(-1).mode, { autoPlay: false, resume: false });
  } finally {
    await h.dispose();
  }
});

test("an episode dated in the future can play when the user allows unreleased episodes", async () => {
  const future = new Date(Date.now() + 2 * 86400000).toISOString();
  const item = {
    _id: "future-card",
    type: "series",
    name: "Future Card",
    upNext: true,
    state: {
      season: 1,
      episode: 2,
      video_id: "future-card:1:2",
      duration: 600000,
      timeOffset: 0,
    },
  };
  const seasonEpisodes = [{ episode: 2, name: "Episode 2", airDate: future }];
  const flush = () =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const playButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>("button[title='Play']"),
  ];

  const blocked = harness(null, { item, seasonEpisodes, settings: { cwPlayUnreleased: false } });
  try {
    await blocked.render();
    await flush();
    const buttons = playButtons();
    assert.ok(buttons.length > 0);
    assert.ok(buttons.every((button) => button.disabled));
  } finally {
    await blocked.dispose();
  }

  const allowed = harness(null, { item, seasonEpisodes, settings: { cwPlayUnreleased: true } });
  try {
    await allowed.render();
    await flush();
    const buttons = playButtons();
    assert.ok(buttons.length > 0);
    assert.ok(buttons.every((button) => !button.disabled));
    await allowed.click("button[title='Play']");
    const started = allowed.starts.at(-1);
    assert.equal(started.episode.season, 1);
    assert.equal(started.episode.episode, 2);
  } finally {
    await allowed.dispose();
  }
});

test("an open older-card menu cannot execute after a profile change", async () => {
  const h = harness();
  try {
    await h.render();
    await h.context("button[title='Play']");
    const target = h.target;
    h.profile = "fixture-b";
    await h.render();
    assert.equal(target.isValid(), false);
    await assert.rejects(target.primary.actions()[0].run(), /no longer available/);
    await assert.rejects(target.primary.actions()[1].run(), /no longer available/);
    assert.equal(h.starts.length, 0);
    assert.equal(h.removed.length, 0);
  } finally {
    await h.dispose();
  }
});

test("original removal invalidates an already-open card menu and matches removal from a separate equivalent fixture", async () => {
  const original = harness();
  let directItem: unknown;
  try {
    await original.render();
    await original.context("button[title='Play']");
    const openMenu = original.target;
    await original.click("button[aria-label='Remove from Continue Watching']");
    directItem = original.removed[0];
    assert.equal(openMenu.isValid(), false);
    await assert.rejects(openMenu.primary.actions()[0].run(), /no longer available/);
    await assert.rejects(openMenu.primary.actions()[1].run(), /no longer available/);
    assert.equal(original.removed.length, 1);
    assert.equal(original.starts.length, 0);
  } finally {
    await original.dispose();
  }
  const contextual = harness();
  try {
    await contextual.render();
    await contextual.context("button[title='Play']");
    await React.act(() => contextual.target.primary.actions()[1].run());
    assert.deepEqual(contextual.removed, [directItem]);
  } finally {
    await contextual.dispose();
  }
});

const catalogItem = (episode = 11) => ({
  _id: "tt0434665",
  type: "series",
  name: "Bleach",
  state: {
    season: 4,
    episode,
    video_id: `tt0434665:4:${episode}`,
    duration: 1_440_000,
    timeOffset: 60_000,
  },
});

const courVideo = (entry: string, episode = 11) => ({
  id: `kitsu:${entry}:${episode}`,
  title: "The Blade and Me",
  season: 1,
  episode,
  imdbSeason: 4,
  imdbEpisode: episode,
});

test("a checkpoint proof that arrives after mount resolves the cour, title and details", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setTitleValue((checkpoint) =>
    checkpoint?.videoId === "kitsu:49444:11" ? "Bleach: Thousand-Year Blood War" : "Bleach",
  );
  h.setResolveVideo(async () => courVideo("49444"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 0, "no verified source identity yet");

    h.setProof("kitsu:49444");
    h.bumpAnimeIds();
    await h.render();
    await h.flush();

    assert.equal(h.videoCalls.length, 1);
    assert.match(document.body.textContent ?? "", /Thousand-Year Blood War/);
    await h.click("button[aria-label^='Open details']");
    const details = h.starts.filter((entry) => entry.details).at(-1);
    assert.equal(details?.details?.id, "kitsu:49444");
  } finally {
    await h.dispose();
  }
});

test("a late cour result cannot replace a newer cour", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:111");
  h.setTitleValue((checkpoint) =>
    checkpoint?.videoId === "kitsu:222:11"
      ? "Cour B"
      : checkpoint?.videoId === "kitsu:111:11"
        ? "Cour A"
        : "Bleach",
  );
  const pending: Array<(value: unknown) => void> = [];
  h.setResolveVideo(() => new Promise((resolve) => pending.push(resolve)));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.setProof("kitsu:222");
    h.bumpAnimeIds();
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 2);

    await React.act(async () => {
      pending[1](courVideo("222"));
      await Promise.resolve();
    });
    await h.flush();
    assert.match(document.body.textContent ?? "", /Cour B/);

    await React.act(async () => {
      pending[0](courVideo("111"));
      await Promise.resolve();
    });
    await h.flush();
    assert.match(document.body.textContent ?? "", /Cour B/);
    assert.doesNotMatch(document.body.textContent ?? "", /Cour A/);
  } finally {
    await h.dispose();
  }
});

test("a changed identity hides the old cour title before the new one resolves", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:111");
  h.setTitleValue((checkpoint) => (checkpoint?.videoId === "kitsu:111:11" ? "Cour A" : "Bleach"));
  h.setResolveVideo(async () => courVideo("111"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.match(document.body.textContent ?? "", /Cour A/);

    h.setProof("kitsu:222");
    h.setResolveVideo(() => new Promise(() => {}));
    h.bumpAnimeIds();
    await h.render();
    await h.flush();

    assert.doesNotMatch(document.body.textContent ?? "", /Cour A/);
    assert.match(document.body.textContent ?? "", /Bleach/);
  } finally {
    await h.dispose();
  }
});

test("a checkpoint change waits for its own intersection", async () => {
  const h = harness(null, { item: catalogItem(5) });
  h.setProof("kitsu:49444");
  h.setResolveVideo(async () => courVideo("49444", 5));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.setItem(catalogItem(6));
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 1, "the old observation must not authorize E6");

    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 2);
  } finally {
    await h.dispose();
  }
});

test("unrelated version bumps keep a resolved cour while auth changes resolve again", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:49444");
  h.setResolveVideo(async () => courVideo("49444"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.bumpDetection();
    h.bumpAnimeIds();
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 1, "a completed lookup is not repeated");

    h.setAuthKey("other-auth");
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 1, "the reset waits for visibility");
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 2, "a new auth identity resolves again");
  } finally {
    await h.dispose();
  }
});

test("a failed lookup is retried after a relevant bump", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:49444");
  h.setResolveVideo(async () => null);
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.setResolveVideo(async () => courVideo("49444"));
    h.bumpAnimeIds();
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 2);
  } finally {
    await h.dispose();
  }
});

test("detection and a mapping arriving after mount resolve the cour", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setResolveVideo(async () => courVideo("49444"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 0, "no mapping, proof or detection yet");

    h.setAnimeDetected(true);
    h.setAnimeCwId("kitsu:49444");
    h.bumpDetection();
    await h.render();
    await h.flush();

    assert.equal(h.videoCalls.length, 1);
  } finally {
    await h.dispose();
  }
});

test("a recorded Kitsu stream alone makes a catalog card eligible", async () => {
  const base = catalogItem();
  const item = { ...base, state: { ...base.state, video_id: "kitsu:49444:11" } };
  const h = harness(null, { item });
  h.setResolveVideo(async () => courVideo("49444"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1, "the saved stream is a verified source");
  } finally {
    await h.dispose();
  }
});

test("a mapping change hides a title that resolved without a cour video", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:111");
  h.setResolveVideo(async () => null);
  h.setTitleValue("Title A");
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.match(document.body.textContent ?? "", /Title A/);

    h.setTitleValue(() => new Promise(() => {}));
    h.setProof("kitsu:222");
    h.bumpAnimeIds();
    await h.render();
    await h.flush();

    assert.doesNotMatch(document.body.textContent ?? "", /Title A/);
  } finally {
    await h.dispose();
  }
});

test("a late E5 cour cannot replace E6", async () => {
  const h = harness(null, { item: catalogItem(5) });
  h.setProof("kitsu:49444");
  const pending: Array<(value: unknown) => void> = [];
  h.setResolveVideo(() => new Promise((resolve) => pending.push(resolve)));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.setItem(catalogItem(6));
    await h.render();
    await h.flush();
    assert.equal(h.videoCalls.length, 1, "E6 waits for its own observation");
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 2);

    await React.act(async () => {
      pending[1](courVideo("49444", 6));
      await Promise.resolve();
    });
    await h.flush();
    assert.equal(h.titleCalls.at(-1)?.videoId, "kitsu:49444:6");

    await React.act(async () => {
      pending[0](courVideo("49444", 5));
      await Promise.resolve();
    });
    await h.flush();
    assert.equal(h.titleCalls.at(-1)?.videoId, "kitsu:49444:6", "E5 is ignored");
  } finally {
    await h.dispose();
  }
});

test("a hydration reset without a key change re-resolves the cour", async () => {
  const h = harness(null, { item: catalogItem() });
  h.setProof("kitsu:49444");
  h.setResolveVideo(async () => courVideo("49444"));
  try {
    await h.render();
    await h.intersect();
    await h.flush();
    assert.equal(h.videoCalls.length, 1);

    h.setItem({ ...h.item, type: "anime" });
    await h.render();
    await h.intersect();
    await h.flush();

    assert.equal(h.videoCalls.length, 2, "the cleared cour resolves again");
  } finally {
    await h.dispose();
  }
});


test("a repaired anime card plays the verified native stream while resuming its original source", async () => {
  const source = {
    _id: "mal:14719", type: "series", name: "JoJo's Bizarre Adventure (2012)",
    state: {
      season: 6, episode: 1, video_id: "kitsu:49847:1",
      timeOffset: 240_000, duration: 1_440_000,
    },
  };
  const card = {
    ...source,
    _id: "kitsu:49847",
    cwRepairSourceId: source._id,
    cwMembers: [source],
  };
  const h = harness(null, { item: card });
  try {
    await h.render();
    await h.click("button[title='Play']");
    await h.flush();
    const play = h.starts.at(-1);
    assert.equal(play.meta.id, "mal:14719", "resume/sync uses the actual library source");
    assert.equal(play.episode.sourceMetaId, "kitsu:49847", "tracker targets native entry");
    assert.equal(play.episode.kitsuStreamId, "kitsu:49847:1");
    assert.deepEqual(play.mode, { autoPlay: true, resume: true });
    assert.equal(h.playbackQueries.at(-1)?.[0], "mal:14719");

    await h.click("button[title='Choose another source']");
    await h.flush();
    const choose = h.starts.at(-1);
    assert.equal(choose.meta.id, "mal:14719");
    assert.equal(choose.episode.sourceMetaId, "kitsu:49847");
    assert.equal(choose.episode.kitsuStreamId, "kitsu:49847:1");

    await h.click("button[aria-label^='Open details:']");
    assert.equal(h.starts.at(-1)?.details?.id, "kitsu:49847", "details use native owner");

    await h.click("button[aria-label='Remove from Continue Watching']");
    assert.equal(h.removed.length, 1);
    assert.equal(h.removed[0].cwRepairSourceId, "mal:14719");
    assert.deepEqual(h.removed[0].cwMembers, [source]);
  } finally {
    await h.dispose();
  }
});

test("an offline repaired IMDb catalog card uses the verified native stream but keeps catalog resume", async () => {
  const source = {
    _id: "tt2359704", type: "series", name: "JoJo's Bizarre Adventure",
    isAnime: true,
    state: {
      season: 6, episode: 1, video_id: "tt2359704:6:1",
      timeOffset: 360_000, duration: 1_440_000,
    },
  };
  const card = {
    ...source, _id: "kitsu:49847",
    cwRepairSourceId: source._id,
    cwRepairNativeStreamId: "kitsu:49847:1",
    cwMembers: [source],
  };
  const h = harness(null, { item: card });
  try {
    await h.render();
    await h.click("button[title='Play']");
    await h.flush();
    const request = h.starts.at(-1);
    assert.equal(request.meta.id, "tt2359704");
    assert.equal(request.episode.kitsuStreamId, "kitsu:49847:1");
    assert.equal(request.episode.sourceMetaId, "kitsu:49847");
    assert.deepEqual(request.mode, { autoPlay: true, resume: true });
    assert.equal(h.playbackQueries.at(-1)?.[0], "tt2359704");
  } finally {
    await h.dispose();
  }
});

test("split-cour repairs preserve original provider episode 13 for resume and native episode 1 for trackers", async () => {
  const source = {
    _id: "tt13706018", type: "series", name: "Spy x Family",
    isAnime: true,
    state: {
      season: 1, episode: 13, video_id: "tt13706018:1:13",
      timeOffset: 480_000, duration: 1_440_000,
    },
  };
  const card = {
    ...source, _id: "kitsu:45619",
    cwRepairSourceId: source._id,
    cwRepairNativeStreamId: "kitsu:45619:1",
    cwMembers: [source],
  };
  const h = harness(null, { item: card });
  try {
    await h.render();
    await h.click("button[title='Play']");
    await h.flush();
    const request = h.starts.at(-1);
    assert.equal(request.meta.id, "tt13706018");
    assert.equal(request.episode.season, 1);
    assert.equal(request.episode.episode, 13, "original provider coordinate controls resume");
    assert.equal(request.episode.kitsuStreamId, "kitsu:45619:1");
    assert.equal(request.episode.sourceMetaId, "kitsu:45619");
    assert.deepEqual(h.playbackQueries.at(-1), ["tt13706018", 1, 13]);
  } finally {
    await h.dispose();
  }
});
