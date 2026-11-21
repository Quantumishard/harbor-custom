import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { setIdentityInvoker } from "../src/lib/identity/client.ts";
import { resetIdentityFlags, setIdentityFlags } from "../src/lib/identity/flags.ts";
import {
  applyVerifiedCwRepairs,
  clearVerifiedCwRepairs,
  warmVerifiedCwRepairs,
} from "../src/lib/identity/cw-repair.ts";

const jojo = {
  _id: "mal:14719", type: "series", isAnime: true, name: "JoJo",
  state: {
    season: 6, episode: 1, video_id: "kitsu:49847:1",
    lastWatched: "2026-11-19T10:00:00Z", timeOffset: 40, duration: 1000,
  },
};
const native = {
  _id: "kitsu:49847", type: "series", isAnime: true, name: "Steel Ball Run",
  state: {
    season: 6, episode: 1, video_id: "kitsu:49847:1",
    lastWatched: "2026-11-18T10:00:00Z", timeOffset: 20, duration: 1000,
  },
};
const blackClover = {
  _id: "kitsu:13209", type: "series", isAnime: true, name: "Black Clover",
  state: {
    season: 2, episode: 3, video_id: "kitsu:50024:3",
    lastWatched: "2026-11-19T10:00:00Z",
  },
};

function identityHarness(options: {
  ambiguous?: boolean;
  wrongOwner?: boolean;
  noBundle?: boolean;
  conflictingShow?: boolean;
} = {}) {
  clearVerifiedCwRepairs();
  resetIdentityFlags();
  setIdentityFlags({ pack: true, cards: true });
  const queries: string[] = [];
  const entries: Record<string, { entry: number; season: number; tvdb: number; tmdb: number; episodes: number }> = {
    "mal:14719": { entry: 14529, season: 1, tvdb: 262954, tmdb: 45790, episodes: 26 },
    "kitsu:49847": { entry: 30944, season: 6, tvdb: 262954, tmdb: 45790, episodes: 1 },
    "kitsu:44294": { entry: 14535, season: 5, tvdb: 262954, tmdb: 45790, episodes: 12 },
    "kitsu:13209": { entry: 3328, season: 1, tvdb: 331753, tmdb: 73223, episodes: 170 },
    "kitsu:50024": { entry: 3329, season: 2, tvdb: 331753, tmdb: 73223, episodes: 7 },
  };
  setIdentityInvoker(async (command, args) => {
    queries.push(command);
    if (command === "identity_card_hints") {
      return (args?.ids as string[]).map((id) => {
        const row = entries[id];
        if (!row) return { id, entry: null, provisional: true, windows: [] };
        return {
          id, entry: row.entry, provisional: false, mediaType: "TV",
          windows: [{
            tvdb: row.tvdb,
            tmdbtv: options.conflictingShow && id === "mal:14719" ? 999999 : row.tmdb,
            tvdbSeason: row.season,
            tmdbSeason: row.season, tvdbOffset: null, tmdbOffset: null,
          }],
        };
      });
    }
    if (command === "identity_window_owners") {
      const season = Number(args?.season);
      const show = Number(args?.tvdb);
      if (show === 262954 && season === 6) {
        return [{ entry: options.wrongOwner ? 999 : 30944, mediaType: "ONA" }];
      }
      if (show === 262954 && season === 5) {
        return (options.ambiguous ? [14535, 14536, 14537] : [14535])
          .map((entry) => ({ entry, mediaType: "ONA" }));
      }
      if (show === 331753 && season === 2)
        return [{ entry: 3329, mediaType: "TV" }];
      return [];
    }
    if (command === "identity_entry_bundle") {
      if (options.noBundle) return null;
      const row = entries[String(args?.key)];
      return row ? { entry: row.entry, episodes: row.episodes } : null;
    }
    return null;
  });
  return { queries };
}

test("repair is opt-in, and a missing or disabled pack leaves the source row intact", async () => {
  identityHarness();
  setIdentityFlags({ pack: false, cards: false });
  assert.equal(await warmVerifiedCwRepairs([jojo]), false);
  assert.equal(applyVerifiedCwRepairs([jojo])[0], jojo);
});

test("JoJo's mis-keyed Season 6 becomes a display-only native card after exact proof", async () => {
  const { queries } = identityHarness();
  assert.equal(await warmVerifiedCwRepairs([jojo]), true);
  const [repaired] = applyVerifiedCwRepairs([jojo]);
  assert.equal(repaired?._id, "kitsu:49847");
  assert.equal(repaired?.cwRepairSourceId, "mal:14719");
  assert.equal(repaired?.cwRepairNativeStreamId, "kitsu:49847:1");
  assert.equal(repaired?.state, jojo.state, "original playback state is reused without edits");
  assert.deepEqual(repaired?.cwMembers, [jojo], "the library source is retained for dismissal");
  assert.equal(jojo._id, "mal:14719", "the saved row is never modified");
  assert.ok(queries.includes("identity_window_owners"));
  assert.ok(queries.includes("identity_entry_bundle"));
});

test("when the real owner is already present, retain newest progress and both source members", async () => {
  identityHarness();
  await warmVerifiedCwRepairs([jojo, native]);
  const rows = applyVerifiedCwRepairs([jojo, native]);
  assert.equal(rows.length, 1, "duplicate React cards are not created");
  assert.equal(rows[0]?._id, "kitsu:49847");
  assert.equal(rows[0]?.state, jojo.state, "newest native-stream progress wins");
  assert.deepEqual(rows[0]?.cwMembers, [jojo, native]);
  assert.equal(native.state.timeOffset, 20, "existing genuine native checkpoint stays intact");
});

test("a newer genuine native checkpoint wins over older mis-keyed progress", async () => {
  identityHarness();
  const newer = {
    ...native, state: { ...native.state, lastWatched: "2026-11-20T10:00:00Z" },
  };
  await warmVerifiedCwRepairs([jojo, newer]);
  const [row] = applyVerifiedCwRepairs([jojo, newer]);
  assert.equal(row?.state, newer.state);
  assert.deepEqual(row?.cwMembers, [jojo, newer]);
});

test("Black Clover uses the same general verified-owner repair path", async () => {
  identityHarness();
  assert.equal(await warmVerifiedCwRepairs([blackClover]), true);
  const [repaired] = applyVerifiedCwRepairs([blackClover]);
  assert.equal(repaired?._id, "kitsu:50024");
  assert.deepEqual(repaired?.cwMembers, [blackClover]);
});

test("an ambiguous Stone Ocean season is preserved, never hidden", async () => {
  identityHarness({ ambiguous: true });
  const row = {
    ...jojo,
    state: { ...jojo.state, season: 5, video_id: "kitsu:44294:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([row]), false);
  assert.equal(applyVerifiedCwRepairs([row])[0], row);
});

test("an incorrect owner, missing bundle or out-of-range native episode fails closed", async () => {
  identityHarness({ wrongOwner: true });
  assert.equal(await warmVerifiedCwRepairs([jojo]), false);
  identityHarness({ noBundle: true });
  assert.equal(await warmVerifiedCwRepairs([jojo]), false);
  identityHarness();
  const nonexistentEpisode = {
    ...jojo, state: { ...jojo.state, video_id: "kitsu:49847:9" },
  };
  assert.equal(await warmVerifiedCwRepairs([nonexistentEpisode]), false);
});

test("catalog series, movies, malformed stream ids, and changing checkpoints remain untouched", async () => {
  identityHarness();
  const movie = { ...jojo, type: "movie" };
  const catalog = { ...jojo, _id: "tt2359704" };
  const unverified = {
    ...jojo, state: { ...jojo.state, video_id: "tt2359704:6:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([movie, catalog, unverified]), false);
  assert.deepEqual(applyVerifiedCwRepairs([movie, catalog, unverified]), [movie, catalog, unverified]);
  assert.equal(await warmVerifiedCwRepairs([jojo]), true);
  assert.equal(applyVerifiedCwRepairs([unverified])[0], unverified,
    "proof from one checkpoint cannot be reused for a changed stream");
});

test("production Home uses a separate default-off, settings-controlled opt-in", () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(read("src/lib/settings/defaults.ts"), /animeIdentityRepairEnabled: false/);
  assert.match(read("src/views/home/cw-section.tsx"),
    /settings\.animeIdentityEnabled && settings\.animeIdentityRepairEnabled/);
  assert.match(read("src/lib/identity/use-card-grouping.ts"), /warmVerifiedCwRepairs\(items\)/);
  assert.match(read("src/lib/identity/use-card-grouping.ts"), /applyVerifiedCwRepairs\(items\)/);
});

test("repair keeps unrelated duplicate checkpoints and orders merged card by newest activity", async () => {
  identityHarness();
  await warmVerifiedCwRepairs([jojo]);
  const unrelatedA = {
    _id: "kitsu:1234", type: "series",
    state: { season: 1, episode: 1, lastWatched: "2026-11-18T10:00:00Z" },
  };
  const unrelatedB = {
    ...unrelatedA,
    state: { ...unrelatedA.state, episode: 2 },
  };
  const repaired = applyVerifiedCwRepairs([native, unrelatedA, jojo, unrelatedB]);
  assert.deepEqual(repaired.map((r) => r._id), [
    "kitsu:1234", "kitsu:49847", "kitsu:1234",
  ]);
  assert.equal(repaired[0], unrelatedA);
  assert.equal(repaired[2], unrelatedB);
  assert.equal(repaired[1]?.state, jojo.state, "the newest card retains its original placement");
});

test("in-flight proof from the previous pack cannot be applied after invalidation", async () => {
  clearVerifiedCwRepairs();
  resetIdentityFlags();
  setIdentityFlags({ pack: true, cards: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setIdentityInvoker(async (command, args) => {
    if (command === "identity_card_hints") {
      await gate;
      return (args?.ids as string[]).map((id) => ({
        id, entry: id === "mal:14719" ? 14529 : 30944, provisional: false,
        mediaType: "TV", windows: [{
          tvdb: 262954, tmdbtv: 45790,
          tvdbSeason: id === "mal:14719" ? 1 : 6,
          tmdbSeason: id === "mal:14719" ? 1 : 6,
        }],
      }));
    }
    if (command === "identity_window_owners") return [{ entry: 30944, mediaType: "ONA" }];
    if (command === "identity_entry_bundle") return { entry: 30944, episodes: 1 };
    return null;
  });
  const pending = warmVerifiedCwRepairs([jojo]);
  clearVerifiedCwRepairs();
  release();
  assert.equal(await pending, false);
  assert.equal(applyVerifiedCwRepairs([jojo])[0], jojo);
});

test("provider lookup errors never hide the original row", async () => {
  clearVerifiedCwRepairs();
  resetIdentityFlags();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async () => { throw new Error("offline"); });
  assert.equal(await warmVerifiedCwRepairs([jojo]), false);
  assert.equal(applyVerifiedCwRepairs([jojo])[0], jojo);
});

test("external tracker, next-up, manual watched and local checkpoints remain untouched", async () => {
  identityHarness();
  const excluded = [
    { ...jojo, external: "simkl" },
    { ...jojo, external: "trakt" },
    { ...jojo, local: true },
    { ...jojo, manualWatched: true },
    { ...jojo, upNext: true },
    { ...jojo, caughtUp: true },
    { ...jojo, waitingForAir: true },
  ];
  assert.equal(await warmVerifiedCwRepairs(excluded), false);
  assert.deepEqual(applyVerifiedCwRepairs(excluded), excluded);
});

test("a protected native up-next or tracker card is never overwritten by a repair", async () => {
  identityHarness();
  await warmVerifiedCwRepairs([jojo]);
  for (const protectedRow of [
    { ...native, upNext: true },
    { ...native, caughtUp: true },
    { ...native, external: "simkl" },
    { ...native, manualWatched: true },
  ]) {
    const rows = [jojo, protectedRow];
    const after = applyVerifiedCwRepairs(rows);
    assert.equal(after[0], jojo);
    assert.equal(after[1], protectedRow);
  }
});

test("an exactly proven IMDb catalog episode resolves to its one native owner", async () => {
  identityHarness();
  const catalog = {
    ...jojo,
    _id: "tt2359704",
    state: { ...jojo.state, video_id: "tt2359704:6:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([catalog], async () => ({
    target: "kitsu:49847", nativeEpisode: 1,
  })), true);
  const [display] = applyVerifiedCwRepairs([catalog]);
  assert.equal(display?._id, "kitsu:49847");
  assert.equal(display?.cwRepairSourceId, "tt2359704");
  assert.equal(display?.cwRepairNativeStreamId, "kitsu:49847:1");
  assert.equal(display?.state, catalog.state);
  assert.deepEqual(display?.cwMembers, [catalog]);
});

test("TMDB catalog episode with an exact proof repairs only when show ID matches the offline window", async () => {
  identityHarness();
  const catalog = {
    ...jojo, _id: "tmdb:tv:45790", altIds: ["tt2359704"],
    state: { ...jojo.state, video_id: "tt2359704:6:1" },
  };
  const proof = async () => ({ target: "kitsu:49847", nativeEpisode: 1 });
  assert.equal(await warmVerifiedCwRepairs([catalog], proof), true);
  const [repaired] = applyVerifiedCwRepairs([catalog]);
  assert.equal(repaired?._id, "kitsu:49847");
  assert.equal(repaired?.cwRepairSourceId, catalog._id);
  identityHarness();
  const wrongShow = { ...catalog, _id: "tmdb:tv:12345", altIds: [] };
  assert.equal(await warmVerifiedCwRepairs([wrongShow], proof), false);
  assert.equal(applyVerifiedCwRepairs([wrongShow])[0], wrongShow);
});

test("catalog proof cannot override an ambiguous owner or a conflicting saved native stream", async () => {
  identityHarness({ ambiguous: true });
  const ambiguous = {
    ...jojo, _id: "tt2359704",
    state: { ...jojo.state, season: 5, video_id: "tt2359704:5:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([ambiguous], async () => ({
    target: "kitsu:44294", nativeEpisode: 1,
  })), false);
  identityHarness();
  const wrongStream = {
    ...jojo, _id: "tt2359704",
    state: { ...jojo.state, video_id: "kitsu:44294:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([wrongStream], async () => ({
    target: "kitsu:49847", nativeEpisode: 1,
  })), false);
  const wrongVideoId = {
    ...jojo, _id: "tt2359704",
    state: { ...jojo.state, video_id: "tt00000:6:1" },
  };
  assert.equal(await warmVerifiedCwRepairs([wrongVideoId], async () => ({
    target: "kitsu:49847", nativeEpisode: 1,
  })), false);
});

test("repaired proxy retains the original source for playback and never fabricates a cloud source", async () => {
  identityHarness();
  assert.equal(await warmVerifiedCwRepairs([jojo]), true);
  const [card] = applyVerifiedCwRepairs([jojo]);
  assert.equal(card?.cwRepairSourceId, jojo._id);
  assert.notEqual(card?._id, jojo._id);
  assert.deepEqual(card?.cwMembers, [jojo]);
  const rendered = readFileSync(new URL("../src/components/continue-card.tsx", import.meta.url), "utf8");
  const dismissal = readFileSync(new URL("../src/lib/cw-dismiss.ts", import.meta.url), "utf8");
  assert.match(rendered, /readActualPlaybackForTarget\(playbackMeta\.id/);
  assert.match(rendered, /readResumeEntry\(playbackMeta\.id/);
  assert.match(rendered, /openPicker\(playbackMeta, episode/);
  assert.match(dismissal, /if \(member\.cwRepairSourceId\) continue;/);
});

test("contradictory known TVDB/TMDB show mapping rejects a native repair", async () => {
  identityHarness({ conflictingShow: true });
  assert.equal(await warmVerifiedCwRepairs([jojo]), false);
  assert.equal(applyVerifiedCwRepairs([jojo])[0], jojo);
});
