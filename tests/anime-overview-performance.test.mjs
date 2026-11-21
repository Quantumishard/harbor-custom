import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as cache from "../src/lib/cache.ts";
import * as scheduler from "../src/lib/request-scheduler.ts";
import * as language from "../src/lib/episode-text-language.ts";
import { mergeAnimeDetailExtras } from "../src/lib/providers/anime-detail-extras.ts";
import * as animeArtQuality from "../src/lib/providers/anime-art-quality.ts";

function load(path, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  dependencies = {
    "@/lib/media-cache": { onMediaCacheClear() {}, mediaCacheGeneration: () => 0 },
    ...dependencies,
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    AbortSignal,
    URLSearchParams,
    ...globals,
    require: (name) => {
      if (name === "@/lib/metadata-policy") return { addonOnlyMetadata: () => false };
      assert.ok(name in dependencies, `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function kitsuFixture(fetch) {
  let now = 1000;
  return {
    ...load(
      "src/lib/providers/kitsu.ts",
      {
        "@/lib/cache": cache,
        "@/lib/media-cache": {
          loadMedia: async (_namespace, _scope, loader) => ({
            value: await loader(),
            storedAt: now,
          }),
          metadataCacheTtl: () => 12 * 60 * 60_000,
          onMediaCacheClear() {},
          mediaCacheGeneration: () => 0,
        },
        "@/lib/request-scheduler": scheduler,
        "@/lib/maintenance": { registerEvictable: () => {} },
        "@/lib/safe-fetch": { safeFetch: fetch },
        "@/lib/addons-store/adult-filter": { adultContentHidden: () => false },
        "@/lib/episode-text-language": language,
        "./source-fingerprint": { sourceFingerprint: (value) => JSON.stringify(value) },
      },
      { Date: { now: () => now } },
    ),
    advance: (ms) => {
      now += ms;
    },
  };
}

function episodePage(offset, length, count) {
  return {
    ok: true,
    json: async () => ({
      data: Array.from({ length }, (_, i) => ({
        id: String(offset + i + 1),
        attributes: { number: offset + i + 1, canonicalTitle: `Title ${offset + i + 1}` },
      })),
      meta: { count },
    }),
  };
}

test("Kitsu shares concurrent pages, fetches in parallel, and returns an ordered exact limit", async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const f = kitsuFixture(async (url) => {
    const params = new URL(url).searchParams;
    const offset = Number(params.get("page[offset]"));
    const size = Number(params.get("page[limit]"));
    calls.push(offset);
    peak = Math.max(peak, ++active);
    await tick();
    active--;
    return episodePage(offset, size, 100);
  });
  const [first, second] = await Promise.all([f.kitsuEpisodes(12, 95), f.kitsuEpisodes(12, 95)]);
  assert.deepEqual(
    Array.from(first, (ep) => ep.number),
    Array.from({ length: 95 }, (_, i) => i + 1),
  );
  assert.equal(second.length, 95);
  assert.equal(calls.length, 5);
  assert.ok(peak >= 2 && peak <= 4);
  await f.kitsuEpisodes(12, 95);
  assert.equal(calls.length, 5, "warm loads do not fetch");
  f.advance(31 * 60_000);
  await f.kitsuEpisodes(12, 95);
  assert.equal(calls.length, 10, "cached pages expire");
});

test("Kitsu uses the reported count and retries a failed middle page without skipping episodes", async () => {
  const calls = [];
  let fail = true;
  const f = kitsuFixture(async (url) => {
    const offset = Number(new URL(url).searchParams.get("page[offset]"));
    calls.push(offset);
    if (offset === 20 && fail) return { ok: false };
    return episodePage(offset, offset === 40 ? 5 : 20, 45);
  });
  assert.equal((await f.kitsuEpisodes(12, 100)).length, 20);
  fail = false;
  assert.equal((await f.kitsuEpisodes(12, 100)).length, 45);
  assert.deepEqual(calls, [0, 20, 40, 20]);
});

test("Kitsu's page cache is bounded across a long browsing session", async () => {
  let calls = 0;
  const f = kitsuFixture(async () => {
    calls++;
    return episodePage(0, 1, 1);
  });
  for (let id = 1; id <= 302; id++) await f.kitsuEpisodes(id, 1);
  await f.kitsuEpisodes(1, 1);
  assert.equal(calls, 303);
});

test("catalog artwork checks the caller's film or series kind on cache load and live refresh", async () => {
  const filmIds = ["kitsu:48323", "kitsu:6539"];
  const series = { format: "TV", bg: "series.jpg", logo: "series.png" };
  const film = { format: "MOVIE", bg: "film.jpg", logo: "film.png" };
  const seed = {
    v: 1,
    art: {
      "kitsu:12": series,
      "kitsu:42": film,
      "kitsu:43": { bg: "unknown.jpg" },
      ...Object.fromEntries(filmIds.map((id) => [id, series])),
    },
  };
  const cached = structuredClone(seed);
  const updated = structuredClone(seed);
  updated.v++;
  updated.art["kitsu:12"].bg = "updated-series.jpg";
  let latest;
  const catalog = load(
    "src/lib/providers/anime-hero-art-static.ts",
    {
      "@/lib/config/endpoints": { HARBOR_API_BASE: "https://fixture.invalid" },
      "@/lib/safe-fetch": { safeFetch: async () => ({ ok: true, json: async () => updated }) },
      "./anime-hero-art-cache": {
        readHeroArtCache: async () => ({
          savedAt: 0,
          v: cached.v,
          count: Object.keys(cached.art).length,
          payload: cached,
        }),
        writeHeroArtCache: async (entry) => {
          latest = entry;
        },
      },
    },
    { fetch: async () => ({ ok: true, json: async () => seed }) },
  );

  await catalog.ensureStaticHeroArt();
  for (const id of filmIds) assert.equal(catalog.peekStaticHeroArt(id, "movie"), undefined);
  await tick();
  assert.equal(latest.v, updated.v);
  assert.equal(catalog.peekStaticHeroArt("kitsu:12", "tv").bg, "updated-series.jpg");
  for (const id of filmIds) assert.equal(catalog.peekStaticHeroArt(id, "movie"), undefined);
  assert.equal(catalog.peekStaticHeroArt("kitsu:42", "movie").logo, "film.png");
  assert.equal(catalog.peekStaticHeroArt("kitsu:42", "tv"), undefined);
  assert.equal(catalog.peekStaticHeroArt("kitsu:43", "movie"), undefined);
});

test("legacy anime artwork is ignored for films and cannot leak into newly saved movie art", () => {
  const legacy = { t: Date.now(), bg: "old-series.jpg", logo: "old-series.png" };
  let stored = JSON.stringify({
    map: {
      "kitsu:6539": legacy,
      "kitsu:5646": legacy,
      tt30472557: legacy,
      "tmdb:movie:225745": { ...legacy, kind: "movie", logo: "movie-logo.png" },
    },
  });
  const artCache = load(
    "src/lib/providers/anime-art-cache.ts",
    {
      "@/lib/maintenance": { registerEvictable() {} },
      "@/lib/memory-profiler": { registerCache() {} },
      "./anime-art-quality": animeArtQuality,
    },
    {
      localStorage: {
        getItem: () => stored,
        setItem: (_key, value) => {
          stored = value;
        },
      },
    },
  );

  const cachedMovie = artCache.peekAnimeArt("tmdb:movie:225745", "movie");
  assert.equal(cachedMovie.bg, undefined);
  assert.equal(cachedMovie.logo, "movie-logo.png");
  for (const id of ["kitsu:6539", "tt30472557"]) {
    assert.equal(artCache.peekAnimeArt(id, "movie"), undefined);
    artCache.saveAnimeArt(id, "movie", { bg: "movie.jpg" });
    assert.equal(artCache.peekAnimeArt(id, "movie").bg, "movie.jpg");
    assert.equal(artCache.peekAnimeArt(id, "movie").logo, undefined);
    assert.equal(artCache.peekAnimeArt(id, "tv"), undefined);
    assert.equal(JSON.parse(stored).map[id].kind, "movie");
  }
  assert.equal(artCache.peekAnimeArt("kitsu:5646", "tv").bg, legacy.bg);
});

test("mapped anime films use the textless TMDB backdrop and keep their localized logo", async () => {
  const requested = [];
  const backdrops = [
    { file_path: "/with-title.jpg", iso_639_1: "en", vote_average: 9 },
    { file_path: "/unknown.jpg", vote_average: 8 },
    { file_path: "/clean.jpg", iso_639_1: null, vote_average: 6 },
  ];
  const logos = [{ file_path: "/localized-logo.png", iso_639_1: "en" }];
  const images = load("src/lib/providers/tmdb/tmdb-images.ts", {
    "@/lib/cache": cache,
    "@/lib/memory-profiler": { registerCache() {} },
    "@/lib/settings/load": { loadStoredSettings: () => ({}) },
    "./tmdb-client": { get: async () => ({ backdrops, logos }) },
    "./tmdb-image-rungs": {
      tmdbBackdropUrl: (path) => path,
      tmdbLogoUrl: (path) => path,
    },
    "./tmdb-image-lang": { imageLangParam: () => "en,ja,null", imageLangRank: () => 1 },
  });
  const tmdb = load("src/lib/providers/tmdb/tmdb-anime.ts", {
    "./tmdb-client": {
      get: async (_key, path, params) => {
        requested.push(path);
        if (path.startsWith("search/")) {
          return { results: [{ id: 116, title: "Steins;Gate", release_date: "2013-01-01" }] };
        }
        assert.equal(params.include_image_language, "en,ja,null");
        return { backdrops, logos };
      },
    },
    "./tmdb-images": images,
    "./tmdb-image-lang": { imageLangParam: () => "en,ja,null" },
  });

  const title = "Steins;Gate: The Movie − Load Region of Déjà Vu";
  const art = await tmdb.tmdbAnimeLogo("key", title, "2013", "movie", {
    exact: true,
    tmdbId: 225745,
  });
  assert.deepEqual(requested, ["movie/225745/images"]);
  assert.equal(art.backdrop, "https://image.tmdb.org/t/p/original/clean.jpg");
  assert.equal(art.logo, "/localized-logo.png");
  assert.deepEqual(Array.from(art.textlessBackdrops), [art.backdrop]);
  assert.deepEqual(Array.from(await images.tmdbMovieImages("key", "tmdb:movie:225745")), [
    "/clean.jpg",
    "/with-title.jpg",
    "/unknown.jpg",
  ]);
  assert.equal(backdrops[0].file_path, "/with-title.jpg");
  assert.equal(await tmdb.tmdbAnimeLogo("key", title, "2013", "movie", { exact: true }), null);
  assert.deepEqual(requested, ["movie/225745/images", "search/movie"]);

  backdrops.pop();
  const fallback = await tmdb.tmdbAnimeLogo("key", title, "2013", "movie", { tmdbId: 225745 });
  assert.equal(fallback.backdrop, "https://image.tmdb.org/t/p/original/with-title.jpg");
  assert.equal(fallback.textlessBackdrops, undefined);
});

test("a mapped anime TV id skips the search and keeps the original image language", async () => {
  const requested = [];
  const tmdb = load("src/lib/providers/tmdb/tmdb-anime.ts", {
    "./tmdb-client": {
      get: async (_key, path, params) => {
        requested.push({ path, params });
        return {
          backdrops: [
            { file_path: "/with-title.jpg", iso_639_1: "en", vote_average: 9 },
            { file_path: "/clean.jpg", iso_639_1: null, vote_average: 6 },
          ],
          logos: [{ file_path: "/logo.png", iso_639_1: "ja" }],
        };
      },
    },
    "./tmdb-images": {
      pickLogo: (logos) => logos[0]?.file_path,
      textlessTmdbBackdrops: (backdrops) => backdrops.filter((b) => !b.iso_639_1),
    },
    "./tmdb-image-lang": {
      imageLangParam: (lang) => (lang === "ja" ? "en,ja,null" : "en,null"),
    },
  });
  const art = await tmdb.tmdbAnimeLogo("key", "One Piece", "1999", "tv", {
    tmdbId: 30984,
    originalLang: "ja",
  });
  assert.equal(art.tmdbId, 30984);
  assert.equal(art.backdrop, "https://image.tmdb.org/t/p/original/clean.jpg");
  assert.deepEqual(
    requested.map((request) => request.path),
    ["tv/30984/images"],
  );
  assert.equal(requested[0].params.include_image_language, "en,ja,null");
});

test("TVDB proxy caches share requests, isolate order types, expire, and retry failures", async () => {
  let calls = 0;
  let fail = false;
  let now = 1000;
  const f = load(
    "src/lib/providers/tvdb-proxy.ts",
    {
      "@/lib/cache": cache,
      "@/lib/config/endpoints": { HARBOR_TVDB_BASE: "https://fixture.invalid" },
      "./anime-mapping": { kitsuToTvdb: async () => 100 },
      "@/lib/safe-fetch": {
        safeFetch: async () => {
          calls++;
          await tick();
          return {
            ok: !fail,
            json: async () => ({ images: { s1e1: "image" }, backgrounds: ["bg"] }),
          };
        },
      },
    },
    { Date: { now: () => now } },
  );
  for (const lookup of [
    { kind: "movie", kitsuId: 48323 },
    { kind: "movie", imdb: "tt2967286" },
    { kind: "movie", kitsuId: 6539, series: 244061 },
  ]) {
    const art = await f.fetchTvdbArtwork(lookup);
    assert.equal(art.backgrounds.length, 0);
  }
  assert.equal(calls, 0);

  await Promise.all([
    f.fetchTvdbProxyImages({ kitsuId: 12 }),
    f.fetchTvdbProxyImages({ series: 100 }),
  ]);
  assert.equal(calls, 1);
  await f.fetchTvdbProxyImages({ series: 100 });
  assert.equal(calls, 1);
  await f.fetchTvdbProxyImages({ series: 100, type: "dvd" });
  assert.equal(calls, 2);
  now += 31 * 60_000;
  await f.fetchTvdbProxyImages({ series: 100 });
  assert.equal(calls, 3);
  fail = true;
  await f.fetchTvdbArtwork({ kind: "tv", series: 100 });
  fail = false;
  assert.equal((await f.fetchTvdbArtwork({ kind: "tv", series: 100 })).backgrounds[0], "bg");
  assert.equal(calls, 5);
});

function detailFixture(options = {}) {
  let loads = 0;
  let ratingLoads = 0;
  let anilistCalls = 0;
  const tvdb = deferred();
  const extras = deferred();
  const tvdbArt = options.tvdbArt ?? {};
  const anilistArt = options.anilistArt ?? {};
  const episodes = [
    {
      id: 1,
      number: 1,
      title: "Base title",
      streamId: "kitsu:12:1",
      imdbSeason: 2,
      imdbEpisode: 1,
    },
  ];
  const f = load("src/lib/providers/anime-detail.ts", {
    "@/lib/providers/harbor-imdb": {
      harborImdbEpisodes: async () => {
        ratingLoads++;
        return new Map([["2:1", 8.2]]);
      },
    },
      // Airing dates have an isolated suite; keep cache/performance fixtures offline.
      "@/lib/anilist/next-airing": { fetchAnilistAiringSchedule: async () => null },
    "@/lib/providers/anizip": { aniZipByKitsu: async () => ({ mappings: { imdb_id: "tt1" } }) },
    "@/lib/providers/anime-episode-build": {
      buildKitsuEpisodes: () => episodes.map((ep) => ({ ...ep })),
      mergeAniZipEpisodes: () => {},
      mergeTmdbEpisodes: () => {},
      mergeTvdbEpisodes: (items, metadata) => {
        if (metadata) items[0].title = "Translated title";
      },
    },
    "@/lib/providers/anime-kitsu-addon": { animeKitsuMeta: async () => ({ videos: episodes }) },
    "@/lib/providers/anime-entry": {},
    "@/lib/providers/anime-mapping": {
      animeMappingByKitsu: async () => ({ mappings: { imdb_id: "tt1" } }),
      kitsuToTvdb: async () => 100,
      kitsuToAnilist: async () => options.anilistId ?? null,
      applyAnidbSeasonWindow: async () => {},
    },
    "@/lib/providers/episode-placeholder": { episodesMissingTitle: () => false },
    "@/lib/providers/anime-tvdb-source": { isSharedSplitTvdb: () => false },
    "@/lib/streams/anime-identity-core": { splitFranchiseDisplaySeason: () => null },
    "@/lib/providers/mal-episodes": {},
    "@/lib/anilist/relations": { anilistFranchise: async () => [] },
    "@/lib/anilist/browse": {
      anilistArtById: async () => {
        anilistCalls++;
        return anilistArt;
      },
    },
    "./anime-recommendations": { animeRecommendations: async () => [] },
    "./anime-art-quality": {
      pickAnimeHeroBackdrop: (sources) =>
        sources.curated ?? sources.tmdb ?? sources.tvdb ?? sources.kitsu ?? sources.banner,
      reusableAnimeBackdrop: (url) => url,
    },
    "./anime-hero-art-static": { staticHeroArt: async () => undefined },
    "@/lib/providers/anime-episode-enrich": {
      enrichEpisodes: async (items) => {
        items[0].thumbnail = "enriched.jpg";
      },
    },
    "@/lib/providers/fanart": {},
    "@/lib/providers/tvdb-proxy": { fetchTvdbArtwork: async () => tvdbArt },
    "@/lib/providers/tvdb": {
      tvdbLangFromIso1: () => "eng",
      tvdbEpisodesByType: () => tvdb.promise,
      tvdbEpisodesAbsolute: async () => [],
    },
    "@/lib/providers/kitsu": {
      parseKitsuId: (id) => Number(id.slice(6)),
      kitsuAnime: async () => {
        loads++;
        return { id: 12, subtype: "tv", title: "One Piece", genres: [] };
      },
      kitsuEpisodes: async () => episodes,
      kitsuCharacters: () => extras.promise,
      kitsuStudios: async () => [],
      kitsuRelated: async () => [],
      kitsuStreamingLinks: async () => [],
    },
    "@/lib/providers/tmdb": {},
  });
  return {
    ...f,
    tvdb,
    extras,
    loads: () => loads,
    ratingLoads: () => ratingLoads,
    anilistCalls: () => anilistCalls,
  };
}

test("overview remounts share early callbacks and reuse finalized episode snapshots", async () => {
  const f = detailFixture();
  const settings = { uiLanguage: "en" };
  const meta = { id: "kitsu:12", name: "One Piece" };
  const early = [];
  const [first, second] = await Promise.all([
    f.animeDetails(settings, meta, () => early.push("first")),
    f.animeDetails(settings, meta, () => early.push("second")),
  ]);
  assert.equal(f.loads(), 1);
  assert.deepEqual(early, ["first", "second"]);
  assert.equal(first, second);
  f.tvdb.resolve([{ id: 10 }]);
  f.extras.resolve([]);
  const finalized = await first.enrichPromise;
  await tick();
  const warm = await f.animeDetails(settings, meta);
  assert.equal(warm.episodes, finalized);
  assert.equal(warm.episodes[0].title, "Translated title");
  assert.equal(f.loads(), 1);
  await f.animeDetails({ ...settings, uiLanguage: "tr" }, meta);
  assert.equal(f.loads(), 2, "language changes must not reuse another overview scope");
});

test("anime core detail does not wait for TVDB or cast and enrichment cannot mutate published rows", async () => {
  const f = detailFixture();
  let result;
  const work = f
    .animeDetails({ uiLanguage: "en" }, { id: "kitsu:12", name: "One Piece" })
    .then((r) => {
      result = r;
    });
  await tick();
  assert.ok(result, "optional providers must not block the core detail");
  assert.equal(f.ratingLoads(), 1, "ratings start while TVDB and cast are still pending");
  const published = structuredClone(result.episodes);
  f.tvdb.resolve([{ id: 10 }]);
  const enriched = await result.enrichPromise;
  assert.deepEqual(result.episodes, published);
  assert.equal(enriched[0].title, "Translated title");
  assert.equal(enriched[0].thumbnail, "enriched.jpg");
  assert.equal(enriched[0].thumbnailFallback, published[0].thumbnailFallback);
  assert.equal(enriched[0].streamId, "kitsu:12:1");
  assert.equal(enriched[0].imdbSeason, 2);
  f.extras.resolve([]);
  await result.extrasPromise;
  await work;
});

test("anime hero art skips the AniList banner when another provider has a backdrop", async () => {
  const f = detailFixture({
    tvdbArt: { backgrounds: ["tvdb.jpg"] },
    anilistId: 1,
    anilistArt: { banner: "banner.jpg" },
  });
  const result = await f.animeDetails({ uiLanguage: "en" }, { id: "kitsu:12", name: "One Piece" });
  assert.equal(await result.heroBgPromise, "tvdb.jpg");
  assert.equal(f.anilistCalls(), 0);
});

test("anime hero art falls back to the AniList banner only when no artwork exists", async () => {
  const f = detailFixture({ anilistId: 1, anilistArt: { banner: "banner.jpg" } });
  const result = await f.animeDetails({ uiLanguage: "en" }, { id: "kitsu:12", name: "One Piece" });
  assert.equal(await result.heroBgPromise, "banner.jpg");
  assert.equal(f.anilistCalls(), 1);
});

test("supplementary detail patches preserve usable metadata and unchanged state identity", () => {
  const base = {
    logo: "logo",
    poster: "poster",
    cast: [{ id: 1 }],
    gallery: { backdrops: ["bg"], logos: ["logo"], posters: [] },
  };
  assert.equal(
    mergeAnimeDetailExtras(base, {
      logo: undefined,
      poster: "",
      cast: [],
      gallery: { backdrops: [], logos: [], posters: [] },
    }),
    base,
  );
  const result = mergeAnimeDetailExtras(base, {
    gallery: { backdrops: ["new-bg"], logos: [], posters: [] },
    overview: "Localized",
  });
  assert.deepEqual(result.gallery.backdrops, ["bg", "new-bg"]);
  assert.equal(result.overview, "Localized");
  assert.equal(base.overview, undefined);
});

function imageFixture(disk, invoke, now, failStorage = false) {
  const reads = [];
  const effects = [];
  const states = [];
  let index = 0;
  const f = load(
    "src/lib/remote-image-proxy.ts",
    {
      react: {
        useState(initial) {
          const slot = index++;
          if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
          return [
            states[slot],
            (value) => {
              states[slot] = typeof value === "function" ? value(states[slot]) : value;
            },
          ];
        },
        useEffect: (effect) => effects.push(effect),
      },
      "@tauri-apps/api/core": {
        invoke,
        convertFileSrc: (path) => `asset:${path}`,
      },
      "@/lib/manga/sources/suwayomi/auth-registry": { suwayomiAuthFor: () => null },
      "@/lib/settings": { useSettings: () => ({ settings: { posterQuality: "high" } }) },
      "./request-scheduler": load("src/lib/request-scheduler.ts"),
      "./object-url-cache": load(
        "src/lib/object-url-cache.ts",
        {},
        {
          Blob,
          URL: { createObjectURL: () => "blob:cached-image", revokeObjectURL() {} },
          setTimeout,
          Date: { now },
        },
      ),
      "@/lib/idb-cache": {
        idbCacheGet: async (key) => {
          reads.push(key);
          if (failStorage) throw new Error("disabled storage");
          return disk.get(key);
        },
        idbCacheSet: async (key, value) => {
          disk.set(key, value);
        },
        idbCacheKeys: async () => [...disk.keys()],
        idbCacheDelete: async (key) => {
          disk.delete(key);
        },
      },
    },
    {
      window: { __TAURI_INTERNALS__: {} },
      Blob,
      Uint8Array,
      atob,
      Date: { now },
      URL: { createObjectURL: () => "blob:cached-image" },
    },
  );
  return {
    ...f,
    reads,
    render(url, options = {}) {
      index = 0;
      effects.length = 0;
      const result = f.useProxiedImageSrc(url, { forceProxy: true, persistent: true, ...options });
      effects.forEach((effect) => effect());
      return result;
    },
  };
}

test("public poster requests opt into the native persistent cache and clearing removes legacy entries", async () => {
  const disk = new Map([["season-poster:v1:old", { at: 0, data: new Blob(["old"]) }]]);
  const calls = [];
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === "cached_thumb_path") return null;
    return { ok: true, body: "aW1hZ2U=", contentType: "image/jpeg" };
  };
  const first = imageFixture(disk, invoke, () => 1000);
  first.render("https://artworks.thetvdb.com/season.jpg");
  await tick();
  const fetchCall = calls.find((call) => call.name === "harbor_fetch");
  assert.equal(fetchCall.args.args.cacheImage, true);
  assert.equal(fetchCall.args.args.maxResponseBytes, 32 * 1024 * 1024);
  assert.equal(disk.size, 1, "new images are stored by the native cache");
  await first.clearThumbCache();
  assert.equal(disk.size, 0);
  assert.equal(calls.at(-1).name, "clear_thumb_cache");
});

test("sized posters use the same width for cache lookup and native fetch", async () => {
  const calls = [];
  const f = imageFixture(
    new Map(),
    async (name, args) => {
      calls.push([name, args]);
      if (name === "cached_thumb_path") return null;
      return { ok: true, body: "", contentType: "image/jpeg", assetPath: "fixture.jpg" };
    },
    () => 1000,
  );
  f.render("https://artworks.thetvdb.com/poster.jpg", { thumbWidthPx: 342 });
  await tick();
  assert.equal(calls[0][1].width, 342);
  assert.equal(calls[1][1].args.thumbWidthPx, 342);
  assert.equal(calls[1][1].args.returnImageAsset, true);
  assert.deepEqual(f.reads, []);
});

test("a newly cached poster uses the asset path and skips unrelated legacy blob reads", async () => {
  const disk = new Map([["season-poster:v1:other", { at: 1000, data: new Blob(["old"]) }]]);
  const calls = [];
  const f = imageFixture(
    disk,
    async (name, args) => {
      calls.push({ name, args });
      if (name === "cached_thumb_path") return null;
      return { ok: true, body: "", contentType: "image/jpeg", assetPath: "C:\\cache\\new.jpg" };
    },
    () => 1000,
    true,
  );
  const url = "https://artworks.thetvdb.com/new.jpg";
  f.render(url);
  await tick();
  assert.equal(f.render(url), "asset:C:\\cache\\new.jpg");
  assert.deepEqual(f.reads, []);
  assert.equal(calls.find((call) => call.name === "harbor_fetch").args.args.returnImageAsset, true);
});

test("unavailable poster storage falls back to fetching the image", async () => {
  let calls = 0;
  const f = imageFixture(
    new Map(),
    async (name) => {
      if (name === "cached_thumb_path") return null;
      calls++;
      return { ok: true, body: "aW1hZ2U=", contentType: "image/jpeg" };
    },
    () => 1000,
    true,
  );
  f.render("https://artworks.thetvdb.com/season.jpg");
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.render("https://artworks.thetvdb.com/season.jpg"), "blob:cached-image");
});

test("a fresh native image is served through the asset path without base64", async () => {
  let fetchCalls = 0;
  const invoke = async (name) => {
    if (name === "cached_thumb_path") return "C:\\cache\\a.jpg";
    fetchCalls++;
    return { ok: true, body: "aW1hZ2U=", contentType: "image/jpeg" };
  };
  const f = imageFixture(new Map(), invoke, () => 1000);
  const url = "https://artworks.thetvdb.com/season.jpg";
  f.render(url);
  await tick();
  assert.equal(f.render(url), "asset:C:\\cache\\a.jpg");
  assert.equal(fetchCalls, 0);
});

test("franchise pooling bounds concurrency and leaving stops queued entries", async () => {
  const effects = [];
  const started = [];
  const jobs = [];
  const { useFranchiseEpisodes } = load(
    "src/views/detail/anime-episodes/use-franchise-episodes.ts",
    {
      react: {
        useMemo: (fn) => fn(),
        useEffect: (fn) => effects.push(fn),
        useState: () => [null, () => {}],
      },
      "@/lib/providers/anime-detail": { isFranchiseExtra: () => false },
      "@/lib/settings": { useSettings: () => ({ settings: { uiLanguage: "en" } }) },
      "@/lib/providers/kitsu": { parseKitsuId: (id) => Number(id.slice(6)) },
      "@/lib/providers/anime-franchise-episodes": {
        fetchEntryEpisodes: (id) => {
          const job = deferred();
          started.push(id);
          jobs.push(job);
          return job.promise;
        },
      },
    },
  );
  const franchise = Array.from({ length: 10 }, (_, i) => ({ meta: { id: `kitsu:${i + 1}` } }));
  useFranchiseEpisodes(franchise, "kitsu:1", [], true);
  const cleanup = effects[0]();
  assert.equal(started.length, 3);
  cleanup();
  jobs.forEach((job) => job.resolve([]));
  await tick();
  assert.equal(started.length, 3, "unmounted pages must not start remaining network jobs");
});

test("inactive anime order skips duplicate provider loading and catalog construction", () => {
  let enabled;
  let builds = 0;
  const { useAnimeOrder } = load("src/views/detail/anime-episodes/use-anime-order.ts", {
    react: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useState: (value) => [value, () => {}],
    },
    "@/lib/i18n": { useT: () => (text) => text },
    "@/lib/providers/tmdb/tmdb-client": { tmdbLanguageIso: () => "en" },
    "../series-episodes/use-episode-order": {
      useEpisodeOrder: (...args) => {
        enabled = args[5];
        return {};
      },
    },
    "./anime-order-utils": {
      buildAnimeOrder: () => {
        builds++;
        return null;
      },
    },
    "@/lib/streams/anime-identity": {},
    "@/lib/providers/kitsu": { parseKitsuId: () => 12 },
    "@/lib/streams/anime-identity-core": {},
  });
  assert.equal(
    useAnimeOrder("tt1", "kitsu:12", [], "tvdb", "aired", "", undefined, undefined, false, false),
    null,
  );
  assert.equal(enabled, false);
  assert.equal(builds, 0);
  useAnimeOrder("tt1", "kitsu:12", [], "tvdb", "aired", "");
  assert.equal(enabled, true);
  assert.equal(builds, 1, "the fallback remains available when explicitly enabled");
});

test("concurrent franchise traversals share AniList relation reads and expire them", async () => {
  let calls = 0;
  let now = 1000;
  const { anilistFranchise } = load(
    "src/lib/anilist/relations.ts",
    {
      "./client": {
        anilistRequest: async () => {
          calls++;
          await tick();
          return { Media: { relations: { edges: [] } } };
        },
      },
      "@/lib/providers/anime-mapping": { kitsuToAnilist: async () => 1 },
    },
    { Date: { now: () => now } },
  );
  await Promise.all([anilistFranchise(12), anilistFranchise(12)]);
  assert.equal(calls, 1);
  await anilistFranchise(12);
  assert.equal(calls, 1);
  now += 31 * 60_000;
  await anilistFranchise(12);
  assert.equal(calls, 2);
});
