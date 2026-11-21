import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLiveAnimeScrobble,
  nativeLiveProgressTargets,
  type LiveScrobbleDeps,
} from "../src/lib/identity/live-scrobble.ts";

const source = {
  meta: { id: "mal:14719", type: "series" as const, name: "JoJo's Bizarre Adventure" },
  isAnime: true,
  episode: { season: 6, episode: 1, kitsuStreamId: "kitsu:49847:1", sourceMetaId: "mal:14719" },
  imdbId: "tt2359704",
};
const bundle = {
  entry: 30944, mediaType: "ONA", title: "Steel Ball Run", episodes: 1,
  aliases: [
    { scheme: "kitsu", id: "49847" },
    { scheme: "mal", id: "61469" },
    { scheme: "anilist", id: "190327" },
    { scheme: "anidb", id: "19287" },
  ],
  related: [],
  windows: [{
    anidb: 19287, tvdb: 262954, tmdbtv: 45790,
    tvdbSeason: 6, tmdbSeason: 6, tvdbOffset: null, tmdbOffset: null,
  }],
};
const hints = [
  {
    id: "kitsu:49847", entry: 30944, provisional: false, mediaType: "ONA",
    title: "Steel Ball Run", cardKey: "tvdb:262954", tvdb: 262954, tmdb: 45790,
    season: 6, offset: null, windows: bundle.windows,
  },
  {
    id: "mal:14719", entry: 14529, provisional: false, mediaType: "TV",
    title: "JoJo", cardKey: "tvdb:262954", tvdb: 262954, tmdb: 45790,
    season: 1, offset: null, windows: [{ ...bundle.windows[0], tvdbSeason: 1, tmdbSeason: 1 }],
  },
];

function deps(options: {
  disabled?: boolean;
  ambiguous?: boolean;
  noBundle?: boolean;
  differentShow?: boolean;
  offset?: number;
  noOwners?: boolean;
} = {}): LiveScrobbleDeps {
  const effective = options.offset == null ? bundle : {
    ...bundle, windows: bundle.windows.map((window) => ({ ...window, tmdbOffset: options.offset, tvdbOffset: options.offset })),
  };
  return {
    enabled: () => !options.disabled,
    hints: async (ids) => ids.map((id) => {
      const found = hints.find((hint) => hint.id === id);
      return found ? { ...found, windows: effective.windows } : {
        id, entry: null, title: null, mediaType: null, cardKey: null,
        tvdb: null, tmdb: null, season: null, offset: null, provisional: true,
      };
    }),
    owners: async () => options.noOwners ? [] :
      options.ambiguous ? [
        { entry: 30944, title: null, mediaType: "ONA", tvdb: 262954, tmdb: 45790, season: 6, offset: null },
        { entry: 80000, title: null, mediaType: "TV", tvdb: 262954, tmdb: 45790, season: 6, offset: null },
      ] : [{
        entry: 30944, title: null, mediaType: "ONA", tvdb: 262954,
        tmdb: 45790, season: 6, offset: null,
      }],
    bundle: async () => options.noBundle ? null : options.differentShow
      ? { ...effective, windows: effective.windows.map((window) => ({ ...window, tmdbtv: 9000 })) }
      : effective,
  };
}

test("live Stage 1 verifies JoJo's exact native cour and produces targets for all five services", async () => {
  const proof = await resolveLiveAnimeScrobble(source, deps());
  assert.ok(proof);
  assert.equal(proof.work.entryId, "kitsu:49847");
  assert.equal(proof.work.entryEpisode, 1);
  assert.equal(proof.work.aliases?.anilist, "anilist:190327");
  assert.equal(proof.work.aliases?.mal, "mal:61469");
  assert.equal(proof.work.aliases?.anidb, "anidb:19287");
  assert.deepEqual(nativeLiveProgressTargets(proof), {
    source: "kitsu:49847", episode: 1,
    mal: "mal:61469", anilist: "anilist:190327",
  });
  assert.equal(proof.work.evidence, "pack+window");
  assert.deepEqual(proof.traktTarget, {
    kind: "episode", show: { ids: { tvdb: 262954 } }, season: 6, number: 1,
  });
  assert.deepEqual(proof.pmdbTarget, {
    tmdb_id: 45790, media_type: "tv", season: 6, episode: 1,
  });
  assert.equal(proof.episode.sourceMetaId, "kitsu:49847");
  assert.equal(proof.episode.kitsuStreamId, "kitsu:49847:1");
  assert.equal(source.meta.id, "mal:14719", "the source library identity is unchanged");
  assert.equal(source.episode.sourceMetaId, "mal:14719", "the player's episode is unchanged");
});

test("ambiguous season owners, disabled pack or failed bundle never change the target", async () => {
  assert.equal(await resolveLiveAnimeScrobble(source, deps({ ambiguous: true })), null);
  assert.equal(await resolveLiveAnimeScrobble(source, deps({ disabled: true })), null);
  assert.equal(await resolveLiveAnimeScrobble(source, deps({ noBundle: true })), null);
  assert.equal(await resolveLiveAnimeScrobble(source, deps({ noOwners: true })), null);
});

test("a nonexistent episode or an unrelated source franchise is not verified", async () => {
  assert.equal(await resolveLiveAnimeScrobble({
    ...source, episode: { ...source.episode, kitsuStreamId: "kitsu:49847:2" },
  }, deps()), null);
  const changed = {
    ...source,
    meta: { ...source.meta, id: "mal:9999" },
  };
  assert.equal(await resolveLiveAnimeScrobble(changed, deps()), null);
});

test("a catalog id known to disagree with the TV provider show cannot be rerouted", async () => {
  const wrong = { ...source, meta: { ...source.meta, id: "tmdb:tv:99999" } };
  assert.equal(await resolveLiveAnimeScrobble(wrong, deps()), null);
});

test("provider offsets cannot be inferred from anime entry-relative episode numbering", async () => {
  const proof = await resolveLiveAnimeScrobble(source, deps({ offset: 1 }));
  assert.ok(proof);
  assert.equal(proof.work.entryId, "kitsu:49847");
  assert.equal(proof.traktTarget, null);
  assert.equal(proof.pmdbTarget, null);
});

test("ordinary TV and movies are untouched even when the database exists", async () => {
  assert.equal(await resolveLiveAnimeScrobble({
    ...source, meta: { ...source.meta, type: "movie" },
  }, deps()), null);
  assert.equal(await resolveLiveAnimeScrobble({
    ...source,
    meta: { ...source.meta, id: "tt0000000" },
    episode: { ...source.episode, kitsuStreamId: undefined, sourceMetaId: undefined },
  }, deps()), null);
});


test("unrelated IMDb catalog show cannot borrow a stale Kitsu season for live tracker writes", async () => {
  const unrelated = {
    ...source,
    meta: { ...source.meta, id: "tt9999999" },
    episode: {
      ...source.episode,
      imdbId: "tt2359704", imdbSeason: 6, imdbEpisode: 1,
    },
  };
  assert.equal(await resolveLiveAnimeScrobble(unrelated, deps()), null);
  const unproven = {
    ...source,
    meta: { ...source.meta, id: "tt2359704" },
  };
  assert.equal(await resolveLiveAnimeScrobble(unproven, deps()), null,
    "a native stream and matching season alone cannot authenticate an IMDb page");
});

test("exact IMDb show and native video episode mapping can independently verify its owner", async () => {
  const proven = {
    ...source,
    meta: { ...source.meta, id: "tt2359704" },
    episode: {
      ...source.episode,
      imdbId: "tt2359704", imdbSeason: 6, imdbEpisode: 1,
    },
  };
  const proof = await resolveLiveAnimeScrobble(proven, deps());
  assert.equal(proof?.work.entryId, "kitsu:49847");
  assert.equal(proof?.pmdbTarget?.tmdb_id, 45790);
  assert.equal(proof?.traktTarget?.kind, "episode");
  const nativeNumbering = {
    ...proven, episode: { ...proven.episode, season: 1 },
  };
  assert.equal((await resolveLiveAnimeScrobble(nativeNumbering, deps()))?.work.entryId,
    "kitsu:49847", "native episode season 1 may correspond to IMDb season 6");
});

test("an IMDb candidate with missing or contradictory provider coordinates fails closed", async () => {
  for (const patch of [
    { imdbId: undefined }, { imdbSeason: undefined }, { imdbEpisode: undefined },
    { imdbId: "tt9999999" },
  ]) {
    const candidate = {
      ...source,
      meta: { ...source.meta, id: "tt2359704" },
      episode: {
        ...source.episode, imdbId: "tt2359704", imdbSeason: 6, imdbEpisode: 1,
        ...patch,
      },
    };
    assert.equal(await resolveLiveAnimeScrobble(candidate, deps()), null, JSON.stringify(patch));
  }
});
