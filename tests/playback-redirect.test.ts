import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";
import { isPlaybackRedirectCandidate } from "../src/lib/streams/playback-redirect.ts";
import { isLivePlaybackSrc } from "../src/lib/player/live-src.ts";

const original = "https://addon.debridio.com/fixture/play";
const meteorUrl = "https://meteorfortheweebs.midnightignite.me/fixture/play";
const finalUrl = "https://cdn.example.org/fixture.mkv";

const addonHosts = new Set([
  "addon.debridio.com",
  "sooti.click",
  "mediafusion.elfhosted.com",
  "meteorfortheweebs.midnightignite.me",
]);

test("only installed add-on HTTPS origins are eligible", () => {
  assert.equal(isPlaybackRedirectCandidate(original, addonHosts), true);
  assert.equal(isPlaybackRedirectCandidate(meteorUrl, addonHosts), true);
  assert.equal(
    isPlaybackRedirectCandidate("https://mediafusion.elfhosted.com/play", addonHosts),
    true,
  );
  for (const url of [
    finalUrl,
    "https://not-installed.example.org/play",
    "http://addon.debridio.com/play",
    "https://addon.debridio.com.attacker.test/play",
    "https://user:secret@addon.debridio.com/play",
    "https://addon.debridio.com:8443/play",
    "https://meteorfortheweebs.midnightignite.me.attacker.test/play",
    "https://another.midnightignite.me/play",
    "http://meteorfortheweebs.midnightignite.me/play",
    "not a URL",
  ]) {
    assert.equal(isPlaybackRedirectCandidate(url, addonHosts), false, url);
  }
});

const installedAddons = [...addonHosts].map((host, index) => ({
  id: `addon-${index}`,
  transportUrl: `https://${host}/manifest.json`,
  installedAt: 0,
}));

function redirectHarness(invoke: () => Promise<unknown>, native = true, addons = installedAddons) {
  return hookHarness(
    "src/lib/streams/playback-redirect.ts",
    "resolvePlaybackRedirect",
    {
      "@tauri-apps/api/core": { invoke },
      "@/lib/addon-store": { loadInstalled: () => addons },
    },
    { window: native ? { __TAURI_INTERNALS__: {} } : {} },
  );
}

test("ordinary CDN links, header-bound streams, web playback and cancelled requests incur no lookup", async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    return finalUrl;
  };
  const active = new AbortController();
  const cancelled = new AbortController();
  cancelled.abort();
  for (const args of [
    { url: finalUrl, signal: active.signal },
    { url: original, signal: active.signal, headers: { Referer: "https://fixture.test" } },
    { url: original, signal: cancelled.signal },
  ])
    assert.equal(await redirectHarness(invoke).render(args), args.url);
  assert.equal(
    await redirectHarness(invoke, false).render({ url: original, signal: active.signal }),
    original,
  );
  assert.equal(calls, 0);
});

test("uses a resolved URL, with fallback for unavailable native support and invalid targets", async () => {
  const args = { url: original, signal: new AbortController().signal };
  assert.equal(await redirectHarness(async () => finalUrl).render(args), finalUrl);
  assert.equal(
    await redirectHarness(async () => finalUrl).render({ ...args, url: meteorUrl }),
    finalUrl,
  );
  for (const result of [
    null,
    "file:///private",
    "http://cdn.example.org/fixture.mkv",
    "https://user:secret@cdn.example.org/fixture.mkv",
  ]) {
    assert.equal(await redirectHarness(async () => result).render(args), original);
  }
  assert.equal(
    await redirectHarness(async () => {
      throw new Error("native unavailable");
    }).render(args),
    original,
  );
});

test("cancelling during resolution discards the returned URL", async () => {
  let finish!: (url: string) => void;
  const ac = new AbortController();
  const result = redirectHarness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  ).render({ url: original, signal: ac.signal });
  ac.abort();
  finish(finalUrl);
  assert.equal(await result, original);
});

test("only hosts of installed add-ons are probed", async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    return finalUrl;
  };
  const signal = new AbortController().signal;
  assert.equal(
    await redirectHarness(invoke).render({ url: "https://cdn.example.org/play", signal }),
    "https://cdn.example.org/play",
  );
  assert.equal(calls, 0);
  assert.equal(await redirectHarness(invoke).render({ url: original, signal }), finalUrl);
  assert.equal(calls, 1);
});

test("a host without a usable redirect is skipped for the rest of the session", async () => {
  let calls = 0;
  const h = redirectHarness(async () => {
    calls++;
    return null;
  });
  const signal = new AbortController().signal;
  assert.equal(await h.render({ url: original, signal }), original);
  assert.equal(await h.render({ url: original, signal }), original);
  assert.equal(calls, 1);
});

test("an unavailable native resolver does not retire the host", async () => {
  let calls = 0;
  const h = redirectHarness(async () => {
    calls++;
    throw new Error("native unavailable");
  });
  const signal = new AbortController().signal;
  assert.equal(await h.render({ url: original, signal }), original);
  assert.equal(await h.render({ url: original, signal }), original);
  assert.equal(calls, 2);
});

function pickerHarness(
  intent = "play",
  resolveStream = async (stream: { url: string }) => ({
    ok: true,
    via: "direct",
    data: { url: stream.url },
  }),
) {
  const opened: any[] = [],
    history: any[] = [],
    downloads: any[] = [];
  let lookups = 0;
  let redirect = async () => finalUrl;
  const h = hookHarness("src/views/play-picker/use-pick-handler.ts", "usePickHandler", {
    "@/lib/player/live-src": { isLivePlaybackSrc },
    "@/lib/debrid/playback-preparation": { invalidatePreparedDebridLink() {} },
    "@/lib/playback-history": { savePlayback: (_id: string, entry: any) => history.push(entry) },
    "@/lib/season-lock": { saveSeasonLock() {} },
    "@/lib/dead-streams": { markStreamDead() {}, recordStubEvent() {} },
    "@/lib/torrent/stremio-stream": {
      engineP2pEligible: () => false,
      isHostedTorrentServerUrl: () => false,
    },
    "@/lib/streams/cached": { hasUncachedMarker: () => false },
    "@/lib/streams/p2p-prewarm": {
      PLAY_PREWARM_ABANDON_MS: 30_000,
      prewarmP2pStream() {},
    },
    "@/lib/streams/preflight": {
      preflightCheck: () => {
        throw new Error("unexpected preflight");
      },
    },
    "@/lib/streams/resolve": {
      resolveStream,
      shouldPreferP2pDownload: () => false,
    },
    "@/lib/streams/playback-redirect": {
      resolvePlaybackRedirect: () => {
        lookups++;
        return redirect();
      },
    },
    "@/lib/perf/playback-trace": {
      beginPlaybackTrace: () => "fixture",
      finishPlaybackTrace() {},
      markPlaybackTrace() {},
    },
    "@/lib/stream-proxy": {
      registerStreamProxy: () => {
        throw new Error("unexpected proxy");
      },
      unregisterStreamProxy() {},
    },
    "@/lib/together/build-invite": { buildPlayInvite() {} },
    "@/lib/providers/kitsu": { parseKitsuId: () => null },
    "@/lib/streams/anime-identity-core": { splitFranchiseDisplaySeason: () => null },
    "@/lib/window": { openInAppBrowser() {}, openUrl() {} },
    "@/lib/download/downloads-store": {
      enqueueDownload: async (item: any) => downloads.push(item),
    },
    "@/lib/download/season-download": { downloadSeasonFromPack() {} },
    "@/lib/download/season-pack": { isDownloadableSeasonPack: () => false },
    "./picker-utils": {
      formatStreamQuality: () => "1080p",
      isDebridFailure: () => false,
      playError: (code: string) => ({ code }),
      streamIdentity: () => "fixture",
    },
  });
  const noop = () => {};
  const api = h.render({
    meta: { id: "tt100", name: "Fixture" },
    debrids: [],
    isCached: () => true,
    streamMode: "both",
    p2pAutoConsent: true,
    seasonLock: false,
    inSession: false,
    inviteSentRef: { current: null },
    openPlayer: (src: any) => opened.push(src),
    intent,
    autoActive: false,
    autoAttemptIdx: 0,
    autoCandidatesLength: 1,
    autoFiredRef: { current: false },
    setAutoAttemptIdx: noop,
    setAutoExhausted: noop,
    setFailedStreams: noop,
    setResolveError: noop,
    setResolving: noop,
  });
  return {
    ...h,
    api,
    opened,
    history,
    downloads,
    get lookups() {
      return lookups;
    },
    redirect(fn: typeof redirect) {
      redirect = fn;
    },
  };
}

test("manual selection loads the final URL and preserves the original source in history", async () => {
  const h = pickerHarness();
  h.api.onPlay({ url: original });
  await flushPromises();
  assert.equal(h.lookups, 1);
  assert.equal(h.opened[0].url, finalUrl);
  assert.equal(h.opened[0].historyUrl, original);
  assert.equal(h.history[0].url, original);
  assert.equal(h.opened[0].autoFired, false);
});

test("manual Torrentio selection supersedes a pending AIOStreams resolution", async () => {
  let finish!: () => void;
  const h = pickerHarness("play", async (stream) => {
    if (stream.url === original)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return { ok: true, via: "direct", data: { url: stream.url } };
  });
  h.api.onPlay({ addonId: "aiostreams", url: original }, true, false, true);
  h.api.onPlay({ addonId: "torrentio", url: finalUrl });
  await flushPromises();
  finish();
  await flushPromises();
  assert.deepEqual(
    h.opened.map((src) => src.streamRef.addonId),
    ["torrentio"],
  );
  assert.equal(h.opened[0].autoFired, false);
  assert.deepEqual(
    h.history.map((entry) => entry.addonId),
    ["torrentio"],
  );
});

test("automatic selection resolves redirects while downloads keep their existing path", async () => {
  const automatic = pickerHarness();
  automatic.api.onPlay({ url: original }, true, false, true);
  await flushPromises();
  assert.equal(automatic.lookups, 1);
  assert.equal(automatic.opened[0].url, finalUrl);
  assert.equal(automatic.opened[0].historyUrl, original);
  assert.equal(automatic.history[0].url, original);
  assert.equal(automatic.opened[0].autoFired, true);
  const download = pickerHarness("download");
  download.api.onPlay({ url: original });
  await flushPromises();
  assert.equal(download.lookups, 0);
  assert.equal(download.downloads[0].url, original);
});

test("a cancelled manual selection never opens or saves the resolved stream", async () => {
  const h = pickerHarness();
  let finish!: (url: string) => void;
  h.redirect(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.api.onPlay({ url: original });
  await flushPromises();
  h.api.abortResolve();
  finish(finalUrl);
  await flushPromises();
  assert.equal(h.opened.length, 0);
  assert.equal(h.history.length, 0);
});

test("cancelling automatic selection during redirect resolution never opens the result", async () => {
  const h = pickerHarness();
  let finish!: (url: string) => void;
  h.redirect(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.api.onPlay({ url: original }, true, false, true);
  await flushPromises();
  assert.equal(h.lookups, 1);
  h.api.abortResolve();
  finish(finalUrl);
  await flushPromises();
  assert.equal(h.opened.length, 0);
  assert.equal(h.history.length, 0);
});
