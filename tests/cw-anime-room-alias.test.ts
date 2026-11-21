import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Meta = { genres?: string[]; country?: string; originalLanguage?: string };

function fixture(initial: Record<string, string> = {}) {
  const stored = new Map<string, string>(Object.entries(initial));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const flushTimers = () => {
    // Positive detection writes are intentionally batched on beta. Explicitly
    // settle the scheduled writes instead of assuming synchronous storage.
    for (const [id, tick] of [...timers]) {
      timers.delete(id);
      tick();
    }
  };
  const metas = new Map<string, Meta>();
  const directKitsu = new Map<number, number>();
  const cachedImdb = new Map<string, string | null>();
  const tmdbExternal = new Map<string, string | null>();
  const pmdbExternal = new Map<number, string | null>();
  const calls = { tmdbKitsu: [] as number[], tmdbImdb: [] as string[], pmdb: [] as number[] };
  const mocks: Record<string, unknown> = {
    react: { useSyncExternalStore: () => {} },
    "@/lib/render-cause": { noteNotify: () => {} },
    "@/lib/cinemeta": { meta: async (_type: string, id: string) => metas.get(id) ?? null },
    "@/lib/providers/anime-mapping": {
      imdbToKitsu: async () => null,
      tmdbTvToKitsu: async (id: number) => {
        calls.tmdbKitsu.push(id);
        return directKitsu.get(id) ?? null;
      },
    },
    "@/lib/providers/tmdb/tmdb-imdb-resolve": {
      tmdbImdbCached: (id: string) => cachedImdb.get(id),
      tmdbImdbId: async (_key: string, id: string) => {
        calls.tmdbImdb.push(id);
        return tmdbExternal.get(id) ?? null;
      },
    },
    "@/lib/publicmetadb/mappings": {
      getImdbForTmdb: async (id: number) => {
        calls.pmdb.push(id);
        return pmdbExternal.get(id) ?? null;
      },
    },
    "@/lib/providers/kitsu": { kitsuAnime: async () => null },
    "@/lib/storage-recovery": { setItemWithRecovery: (key: string, value: string) => stored.set(key, value) },
  };
  const compiled = ts.transpileModule(
    readFileSync(new URL("../src/lib/anime-detect.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const api = {} as typeof import("../src/lib/anime-detect");
  new Function("require", "exports", "localStorage", "setTimeout", compiled)(
    (name: string) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    api,
    {
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => stored.delete(key),
    },
    (tick: () => void) => {
      const id = ++nextTimer;
      timers.set(id, tick);
      return id;
    },
  );
  return { api, metas, directKitsu, cachedImdb, tmdbExternal, pmdbExternal, calls, stored, flushTimers };
}

test("the Wild Last Boss TMDB record inherits a proven IMDb anime classification", async () => {
  const h = fixture();
  h.cachedImdb.set("tmdb:tv:280042", "tt33258199");
  h.metas.set("tt33258199", { genres: ["Animation"], country: "Japan" });
  await h.api.detectAnimeForCw([{ _id: "tmdb:tv:280042", type: "series" }]);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:280042"), false);
  await h.api.detectAnimeForCw([{ _id: "tt33258199", type: "series" }]);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:280042"), true);
  assert.deepEqual(h.calls.tmdbKitsu, [280042]);
});

test("the CW alias warmup discovers an exact TMDB external ID and persists the positive classification", async () => {
  const h = fixture();
  h.tmdbExternal.set("tmdb:tv:280042", "tt33258199");
  h.metas.set("tt33258199", { genres: ["Animation"], country: "Japan" });
  await h.api.detectAnimeForCw([{ _id: "tt33258199", type: "series" }]);
  await h.api.detectAnimeForCw([{ _id: "tmdb:tv:280042", type: "series" }]);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:280042"), false);
  await h.api.warmCwAnimeRoomAliases([{ _id: "tmdb:tv:280042", type: "series" }], "tmdb-test-key");
  assert.equal(h.api.isDetectedAnime("tmdb:tv:280042"), true);
  assert.deepEqual(h.calls.tmdbImdb, ["tmdb:tv:280042"]);
  h.flushTimers();
  assert.ok(JSON.parse(h.stored.get("harbor.anime.detected.v2") ?? "[]").includes("tmdb:tv:280042"));
});

test("a public metadata external-ID lookup can classify the alias without a TMDB key", async () => {
  const h = fixture();
  h.pmdbExternal.set(280042, "tt33258199");
  h.metas.set("tt33258199", { genres: ["Animation"], country: "Japan" });
  await h.api.warmCwAnimeRoomAliases([{ _id: "tmdb:tv:280042", type: "series" }]);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:280042"), true);
  assert.deepEqual(h.calls.pmdb, [280042]);
});

test("a linked US animated show stays out of anime classification without positive anime evidence", async () => {
  const h = fixture();
  h.cachedImdb.set("tmdb:tv:500", "tt500");
  h.metas.set("tt500", { genres: ["Animation"], country: "United States" });
  await h.api.warmCwAnimeRoomAliases([{ _id: "tmdb:tv:500", type: "series" }], "tmdb-key");
  assert.equal(h.api.isDetectedAnime("tt500"), false);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:500"), false);
  assert.deepEqual(h.calls.tmdbImdb, []);
});

test("an unmapped TMDB series and a TMDB movie are not promoted to anime", async () => {
  const h = fixture();
  await h.api.warmCwAnimeRoomAliases([
    { _id: "tmdb:tv:501", type: "series" },
    { _id: "tmdb:movie:502", type: "movie" },
  ]);
  assert.equal(h.api.isDetectedAnime("tmdb:tv:501"), false);
  assert.deepEqual(h.calls.pmdb, [501]);
});

test("the Home CW pipeline guards both source cards and resurfaced cards after advancement", () => {
  const home = readFileSync(new URL("../src/views/home.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/views/home/hooks/use-cw-advance.ts", import.meta.url), "utf8");
  assert.match(home, /warmCwAnimeRoomAliases\(/);
  assert.match(home, /cwProgressPool\.filter\(\(item\) => isCwMember\(item\)\)/);
  assert.match(hook, /animeMode !== "exclude" \|\| !isAnimeCwItem\(i\)/);
  assert.match(hook, /const dedupExtra = displayExtra\.filter\(/);
});

test("a stale TMDB negative cannot override a verified IMDb anime and is replaced by a durable positive", async () => {
  const id = "tmdb:tv:280042";
  const imdb = "tt33258199";
  const h = fixture({
    "harbor.anime.notanime.v2": JSON.stringify({ t: Date.now(), ids: [id] }),
  });
  h.cachedImdb.set(id, imdb);
  h.metas.set(imdb, { genres: ["Animation"], country: "Japan" });
  await h.api.detectAnimeForCw([{ _id: imdb, type: "series" }]);
  // A stale negative on the TMDB ID must not cancel the positive IMDb result.
  assert.equal(h.api.isDetectedAnime(imdb), true);
  assert.equal(h.api.isDetectedAnime(id), true);
  // The cached link alone is not yet a persisted TMDB positive.
  assert.equal(JSON.parse(h.stored.get("harbor.anime.detected.v2") ?? "[]").includes(id), false);
  await h.api.warmCwAnimeRoomAliases([{ _id: id, type: "series" }], "tmdb-test-key");
  // Reconciliation persists its own positive mark after beta's batched write,
  // even if the cached external ID link is evicted on a future launch.
  h.flushTimers();
  assert.ok(JSON.parse(h.stored.get("harbor.anime.detected.v2") ?? "[]").includes(id));
  assert.ok(JSON.parse(h.stored.get("harbor.anime.detected.v2") ?? "[]").includes(imdb));
});