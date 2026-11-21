import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const store = new Map<string, string>();
let failWrites = false;
let writes = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes += 1;
    if (failWrites) throw new Error("QuotaExceededError");
    store.set(key, value);
  },
  removeItem: (key: string) => store.delete(key),
};

const cache = await import("../src/lib/providers/anime-art-cache.ts");

test("unchanged anime art is not rewritten", () => {
  cache.saveAnimeArt("same", "tv", { logo: "https://img.example/logo.png", backdrops: ["a", "b"] });
  const before = writes;
  cache.saveAnimeArt("same", "tv", { logo: "https://img.example/logo.png", backdrops: ["a", "b"] });
  assert.equal(writes, before);
});

test("a failed anime art write is retried by the next save of unchanged art", () => {
  failWrites = true;
  cache.saveAnimeArt("retry", "tv", { logo: "https://img.example/retry.png" });
  assert.equal(JSON.parse(store.get("harbor.anime.art.v2") ?? "{}").map?.retry, undefined);

  failWrites = false;
  cache.saveAnimeArt("retry", "tv", { logo: "https://img.example/retry.png" });
  assert.equal(
    JSON.parse(store.get("harbor.anime.art.v2") ?? "{}").map?.retry?.logo,
    "https://img.example/retry.png",
  );

  const before = writes;
  cache.saveAnimeArt("retry", "tv", { logo: "https://img.example/retry.png" });
  assert.equal(writes, before);
});

test("unchanged movie art is not rewritten, but a change of kind is", () => {
  cache.saveAnimeArt("film", "movie", { logo: "https://img.example/film.png" });
  const before = writes;
  cache.saveAnimeArt("film", "movie", { logo: "https://img.example/film.png" });
  assert.equal(writes, before);

  cache.saveAnimeArt("film", "tv", { logo: "https://img.example/film.png" });
  assert.equal(writes, before + 1);
  assert.equal(JSON.parse(store.get("harbor.anime.art.v2") ?? "{}").map?.film?.kind, "tv");
});
