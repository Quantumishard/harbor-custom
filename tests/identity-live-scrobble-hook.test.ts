import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";

function source(episode: number) {
  return {
    meta: { id: "mal:14719", type: "series", name: "JoJo" },
    isAnime: true,
    url: "mock://playback",
    episode: { season: 6, episode, kitsuStreamId: "kitsu:49847:" + episode },
  };
}

function createHarness() {
  const pending: Array<{ episode: number; settle: (result: any) => void }> = [];
  const hook = hookHarness(
    "src/lib/identity/use-live-scrobble.ts",
    "useLiveScrobbleResolution",
    {
      "./live-scrobble": {
        resolveLiveAnimeScrobble: (src: any) => new Promise((resolve) => {
          pending.push({ episode: src.episode.episode, settle: resolve });
        }),
      },
    },
  );
  return {
    pending,
    render: (episode: number, enabledSetting = true) =>
      hook.render({ src: source(episode), enabledSetting }),
    unmount: () => hook.unmount(),
  };
}

test("Stage 1 runs once per playback identity and reuses its verified result", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.pending.length, 1);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(1).proof?.work.entryId, "kitsu:49847");
  assert.equal(h.render(1).phase, "ready");
  assert.equal(h.pending.length, 1, "rerenders should not start another lookup");
  h.unmount();
});

test("late result for the previous episode cannot modify the current scrobble target", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.render(2).phase, "resolving");
  assert.equal(h.pending.length, 2);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(2).phase, "resolving", "stale episode cannot win");
  h.pending[1].settle({ work: { entryId: "kitsu:49847", entryEpisode: 2 } });
  await flushPromises();
  assert.equal(h.render(2).proof?.work.entryEpisode, 2);
  h.unmount();
});

test("disabled live-scrobbling never invokes the database and uses stock behavior", () => {
  const h = createHarness();
  assert.equal(h.render(1, false).phase, "off");
  assert.equal(h.pending.length, 0);
  h.unmount();
});

test("missing proof releases tracking to its preexisting provider fallback", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  h.pending[0].settle(null);
  await flushPromises();
  assert.deepEqual(h.render(1), { phase: "ready", proof: null });
  h.unmount();
});


test("disabling then re-enabling while the same episode plays starts a fresh proof", async () => {
  const h = createHarness();
  h.render(1);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(1).phase, "ready");
  assert.equal(h.render(1, false).phase, "off");
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.pending.length, 2);
  h.pending[1].settle(null);
  await flushPromises();
  assert.deepEqual(h.render(1), { phase: "ready", proof: null });
  h.unmount();
});


test("catalog series with only a native sourceMetaId enters Stage 1, while ordinary TV stays unchanged", async () => {
  const calls: string[] = [];
  const h = hookHarness("src/lib/identity/use-live-scrobble.ts", "useLiveScrobbleResolution", {
    "./live-scrobble": {
      resolveLiveAnimeScrobble: async (src: any) => {
        calls.push(src.episode.sourceMetaId ?? "none");
        return null;
      },
    },
  });
  const catalog = {
    meta: { id: "tmdb:tv:45790", name: "JoJo", type: "series" },
    isAnime: false,
    episode: { season: 6, episode: 1, sourceMetaId: "kitsu:49847" },
  };
  assert.equal(h.render({ src: catalog, enabledSetting: true }).phase, "resolving");
  await flushPromises();
  assert.deepEqual(calls, ["kitsu:49847"]);
  assert.equal(h.render({ src: catalog, enabledSetting: true }).phase, "ready");
  const normal = {
    ...catalog,
    episode: { season: 6, episode: 2 },
  };
  assert.equal(h.render({ src: normal, enabledSetting: true }).phase, "off");
  assert.deepEqual(calls, ["kitsu:49847"]);
  h.unmount();
});


test("a corrected IMDb episode mapping invalidates a same-episode verified tracker proof", async () => {
  const pending: Array<{ imdbId: string | undefined; settle: (proof: any) => void }> = [];
  const h = hookHarness(
    "src/lib/identity/use-live-scrobble.ts",
    "useLiveScrobbleResolution",
    { "./live-scrobble": { resolveLiveAnimeScrobble: (src: any) => new Promise((resolve) => {
      pending.push({ imdbId: src.episode.imdbId, settle: resolve });
    }) } },
  );
  const src = {
    ...source(1),
    meta: { id: "tt2359704", type: "series", name: "JoJo" },
    episode: {
      ...source(1).episode,
      imdbId: "tt2359704", imdbSeason: 6, imdbEpisode: 1,
    },
  };
  const enabledSetting = true;
  assert.equal(h.render({ src, enabledSetting }).phase, "resolving");
  pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render({ src, enabledSetting }).proof?.work.entryId, "kitsu:49847");

  // No change to season, episode number, stream, or sourceMetaId: only the
  // independent IMDb evidence was corrected. An older proof cannot survive.
  const corrected = {
    ...src, episode: { ...src.episode, imdbId: "tt9999999" },
  };
  assert.equal(h.render({ src: corrected, enabledSetting }).phase, "resolving");
  assert.equal(pending.length, 2, "new IMDb mapping must trigger a new lookup");
  assert.equal(pending[1].imdbId, "tt9999999");
  pending[1].settle(null);
  await flushPromises();
  assert.deepEqual(h.render({ src: corrected, enabledSetting }), {
    phase: "ready", proof: null,
  }, "stale verified target must not be reused after IMDb evidence changes");
  h.unmount();
});
