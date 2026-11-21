// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  animeTopMatch,
  matchPersonForQuery,
  sameSearchTitle,
} from "../src/lib/search-top-match.ts";
import type { AnimeHit, SearchPerson } from "../src/lib/search.ts";

function hit(name: string, kitsuId: number, year: string): AnimeHit {
  return {
    malId: kitsuId,
    kitsuId,
    format: "TV",
    name,
    year,
    poster: null,
    background: null,
    overview: "",
    score: 8.5,
  };
}

test("an exact or prefix anime title becomes the top match", () => {
  const hits = [
    hit("Rascal Does Not Dream of Santa Claus", 48917, "2025"),
    hit("Rascal Does Not Dream of Bunny Girl Senpai", 41056, "2018"),
    hit("Bleach: Thousand-Year Blood War", 41467, "2022"),
    hit("Bleach: Thousand-Year Blood War - The Separation", 49900, "2023"),
  ];

  assert.equal(animeTopMatch(hits, "Rascal Does Not Dream of Santa Claus")?.meta.id, "kitsu:48917");
  assert.equal(animeTopMatch(hits, "rascal does not dream of")?.meta.id, "kitsu:41056");
  assert.equal(animeTopMatch(hits, "santa claus")?.meta.id, "kitsu:48917");
  assert.equal(
    animeTopMatch(hits, "bleach thousand")?.meta.name,
    "Bleach: Thousand-Year Blood War",
  );
});

test("an exact top match keeps its source", () => {
  assert.equal(sameSearchTitle("Bleach", "bleach"), true);
  assert.equal(sameSearchTitle("Bleach", "bleach thousand"), false);
  assert.equal(
    sameSearchTitle("Rascal Does Not Dream of Bunny Girl Senpai", "rascal santa claus"),
    false,
  );
});

function person(name: string): SearchPerson {
  return { id: 1, name, profile: "/profile.jpg", knownFor: "Cast", popularity: 10 };
}

test("Chainsaw cannot override Chainsaw Man or take Top Match before the anime arrives", () => {
  const query = "chainsaw man";
  const anime = animeTopMatch([hit("Chainsaw Man", 1, "2022")], query);
  assert.equal(anime?.meta.name, "Chainsaw Man");
  assert.equal(matchPersonForQuery([person("Chainsaw")], query), null);
  assert.equal(matchPersonForQuery([person("Chainsaw")], query, anime), null);
});

test("an exact title beats a partial person name while person queries still work", () => {
  const anime = animeTopMatch([hit("Chainsaw Man", 1, "2022")], "chainsaw man");
  assert.equal(matchPersonForQuery([person("Chainsaw Man Jr.")], "chainsaw man", anime), null);
  const actor = person("Keanu Reeves");
  assert.equal(matchPersonForQuery([actor], "keanu re"), actor);
  assert.equal(matchPersonForQuery([actor], "Keanu Reeves"), actor);
});
