import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const DETAIL = readFileSync("src/views/detail.tsx", "utf8");
const MAPPING = readFileSync("src/lib/providers/anime-mapping.ts", "utf8");
const KITSU = readFileSync("src/lib/providers/kitsu.ts", "utf8");

test("anime identity is independent of the metadata source", () => {
  assert.match(DETAIL, /const animeIdentity = idAnime \|\| detectedKitsu != null;/);
  assert.match(
    DETAIL,
    /const isAnime = !prioritizeMetadataAddons && animeIdentity;/,
    "content keeps the addon-first episode source while identity stays true",
  );
});

test("a detected Kitsu entry supplies the canonical tracker id without loading anime metadata", () => {
  assert.match(
    DETAIL,
    /setAnimeCanonicalId\(\(current\) => current \?\? `kitsu:\$\{detectedKitsu\}`\)/,
  );
  assert.match(
    DETAIL,
    /\{actionStage < 2 && animeIdentity && animeTrackerId && \(\s*<AddToAnilistButton/,
  );
  assert.match(
    DETAIL,
    /\{actionStage < 2 && animeIdentity && animeTrackerId && \(\s*<AddToMalButton/,
  );
});

test("addon-only anime detection can resolve external ids without reading built-in metadata", () => {
  assert.match(MAPPING, /aniZipByImdb\(imdbId, true\)/);
  assert.match(MAPPING, /aniZipByTmdbTv\(tmdbId, true\)/);
  assert.match(MAPPING, /kitsuAnime\(kitsuId, undefined, true\)/);
  assert.match(MAPPING, /kitsuMainTvSeries\(kitsuId, true\)/);
  assert.match(DETAIL, /kitsuSearchAnime\(name, 8, true\)/);
  assert.match(
    KITSU,
    /async function get<T>\(\s*path: string,\s*maxAge\?: number,\s*identity = false,\s*strict = false,\s*\)/,
  );
  assert.match(KITSU, /if \(addonOnlyMetadata\(\) && !identity && !strict\) return null;/);
});

test("season switching remounts only the correct provider buttons without duplicate keys", () => {
  const episodes = readFileSync("src/views/detail/anime-episodes.tsx", "utf8");
  const overflow = readFileSync("src/views/detail/hero-action-overflow.tsx", "utf8");

  // Pick the current native entry, rather than the initially opened series.
  assert.match(episodes, /const selectedCanonicalEntryId =/);
  assert.match(episodes, /verifiedNativeOwner \?\? verifiedDisplayOwner/);
  assert.doesNotMatch(
    episodes,
    /premiereEntry\?\.id \?\? savedSeasonEntry\?\.id \?\? searchedSeasonId/,
  );
  assert.match(episodes, /onCanonicalEntry\?\.\(selectedCanonicalEntryId, requiresSeasonOwner\)/);
  assert.match(DETAIL, /const animeTrackerId = seasonTrackerSelection\.requiresOwner/);
  assert.match(DETAIL, /const listTrackerId = isAnime \? animeTrackerId : meta\.id;/);
  assert.match(
    episodes,
    /const nativeOwner = nativeSeasonOwnerId\(nativeSeason, meta\.id, seasonHint\);/,
  );
  assert.match(
    episodes,
    /verifiedSeasonOwnerFromEpisodes\(nativeSeason\?\.episodes \?\? \[\], imdbId, seasonHint\)/,
  );
  assert.match(episodes, /requiresSeasonOwner \? null : displaySourceId/);
  assert.match(episodes, /onCanonicalEntry\?\.\(selectedCanonicalEntryId, requiresSeasonOwner\)/);
  assert.match(DETAIL, /onCanonicalEntry=\{onSeasonCanonicalEntry\}/);
  assert.match(DETAIL, /animeIdentity && animeTrackerId &&/);
  assert.match(DETAIL, /actionStage < 2 && listTrackerId &&/);

  for (const [component, id] of [
    ["AddToAnilistButton", "animeTrackerId"],
    ["AddToMalButton", "animeTrackerId"],
    ["AddToSimklButton", "listTrackerId"],
    ["AddToPmdbButton", "listTrackerId"],
  ]) {
    const provider = component.replace(/^AddTo|Button$/g, "").toLowerCase();
    assert.match(
      DETAIL,
      new RegExp(
        `<${component}\\s+key=\\{\\x60${provider}:\\$\\{${id}\\}\\x60\\}\\s+harborId=\\{${id}\\}`,
      ),
      `${component} must use a provider-scoped season key`,
    );
  }
  for (const provider of ["anilist", "simkl", "pmdb"]) {
    assert.ok(
      overflow.includes("key={`" + provider + ":${" + provider + ".harborId}`}"),
      `${provider} compact menu must also use a provider-scoped key`,
    );
  }
  assert.match(DETAIL, /simkl=\{\s*listTrackerId\s*\?\s*\{\s*harborId: listTrackerId/);
  assert.match(
    DETAIL,
    /anilist=\{isAnime && animeTrackerId \? \{ harborId: animeTrackerId \} : null\}/,
  );
  assert.doesNotMatch(
    episodes,
    /return \(\) => onCanonicalEntry\?\.\(null\);\s*\}, \[selectedCanonicalEntryId/,
  );
});
