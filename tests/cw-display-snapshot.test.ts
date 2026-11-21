// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import type { LibraryItem } from "../src/lib/stremio.ts";
import { providerMappedEpisode } from "../src/lib/cw-anime-episode.ts";
import {
  cwDisplayInputFingerprint,
  cwDisplayOwnerKey,
  restoreCwDisplaySnapshot,
  saveCwDisplaySnapshot,
} from "../src/lib/cw-display-snapshot.ts";

const start = Date.parse("2026-11-14T04:00:00.000Z");
const owner = cwDisplayOwnerKey(["profile-a", "stremio", "account-a", "simkl-a"]);

function store() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function item(id = "tt100", episode = 1): LibraryItem {
  return {
    _id: id,
    type: "series",
    name: "Fixture Show",
    _ctime: "2026-11-13T02:00:00.000Z",
    _mtime: "2026-11-13T02:00:00.000Z",
    state: {
      season: 1,
      episode,
      video_id: id + ":1:" + episode,
      timeOffset: 1750000,
      duration: 1800000,
      flaggedWatched: 0,
      lastWatched: "2026-11-13T02:00:00.000Z",
    },
    external: "simkl",
    providerPlaybackIds: { simkl: "playback-1" },
    altIds: ["tmdb:tv:20"],
  } as LibraryItem;
}

function advanced(input: LibraryItem): LibraryItem {
  return {
    ...input,
    state: {
      ...input.state,
      season: 1,
      episode: 2,
      video_id: input._id + ":1:2",
      timeOffset: 0,
      flaggedWatched: 0,
    },
    upNext: true,
  };
}

test("restores verified next episode without restoring source or dismissal ownership", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  const output = restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1000 });
  const card = output.advanced.get(input._id)!;
  assert.equal(card.state?.episode, 2);
  assert.equal(card.state?.timeOffset, 0);
  assert.equal(card.upNext, true);
  assert.deepEqual(card.providerPlaybackIds, { simkl: "playback-1" });
  assert.deepEqual(card.altIds, ["tmdb:tv:20"]);
  assert.equal(card.cwMembers, undefined);
  assert.equal(output.removed.size, 0);
  assert.equal(s.data.size, 1);
  const payload = [...s.data.values()][0];
  assert.doesNotMatch(payload, /playback-1|Fixture Show|account-a/);
});

for (const external of ["simkl", "trakt", "publicmetadb", undefined] as const) {
  test(`a stale snapshot cannot replace JoJo's paused episode (${external ?? "local"})`, () => {
    const s = store();
    const input = { ...item("kitsu:7158"), external, local: external === undefined };
    const paused = { ...input, state: { ...input.state!, timeOffset: 150480 } };
    const next = advanced(input);
    const options = { store: s, now: start };

    saveCwDisplaySnapshot(owner, [input], new Map([[input._id, next]]), new Set(), options);
    const [key, json] = [...s.data.entries()][0]!;
    const legacy = JSON.parse(json);
    const decision = legacy.decisions[0];
    decision.fingerprint = cwDisplayInputFingerprint(paused);
    decision.display.episode = 8;
    decision.display.videoId = "kitsu:7158:8";
    s.setItem(key, JSON.stringify(legacy));

    assert.equal(restoreCwDisplaySnapshot(owner, [paused], options).advanced.size, 0);
    legacy.decisions = [{ ...decision, kind: "remove" }];
    s.setItem(key, JSON.stringify(legacy));
    assert.equal(restoreCwDisplaySnapshot(owner, [paused], options).removed.size, 0);

    saveCwDisplaySnapshot(owner, [paused], new Map([[input._id, next]]), new Set(), options);
    assert.deepEqual(JSON.parse(s.getItem(key)!).decisions, []);
  });
}

test("verified Black Clover E4 replays provider S2 without rewriting playback coordinates", () => {
  const s = store();
  const source = item("mal:61967", 3);
  const upNext: LibraryItem = {
    ...advanced(source),
    state: {
      ...advanced(source).state!,
      season: 1,
      episode: 4,
      video_id: "kitsu:50024:4",
    },
    cwVerifiedProviderMapping: { imdbSeason: 2, imdbEpisode: 4 },
  };
  saveCwDisplaySnapshot(owner, [source], new Map([[source._id, upNext]]), new Set(), {
    store: s,
    now: start,
  });
  const restored = restoreCwDisplaySnapshot(owner, [source], {
    store: s,
    now: start + 1000,
  }).advanced.get(source._id)!;
  assert.equal(restored.state?.season, 1);
  assert.equal(restored.state?.episode, 4);
  assert.equal(restored.state?.video_id, "kitsu:50024:4");
  assert.deepEqual(restored.cwVerifiedProviderMapping, { imdbSeason: 2, imdbEpisode: 4 });
  assert.deepEqual(
    providerMappedEpisode(restored.cwVerifiedProviderMapping, {
      season: restored.state!.season!,
      episode: restored.state!.episode!,
    }),
    { season: 2, episode: 4 },
  );
  assert.equal(source.cwVerifiedProviderMapping, undefined);
});
test("another account, profile, source, or Nuvio login cannot reuse a snapshot", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  for (const parts of [
    ["profile-b", "stremio", "account-a", "simkl-a"],
    ["profile-a", "stremio", "account-b", "simkl-a"],
    ["profile-a", "nuvio", "account-a", "simkl-a"],
    ["profile-a", "stremio", "account-a", "simkl-b"],
  ]) {
    const result = restoreCwDisplaySnapshot(cwDisplayOwnerKey(parts), [input], {
      store: s,
      now: start + 1000,
    });
    assert.equal(result.advanced.size, 0);
    assert.equal(result.removed.size, 0);
  }
});

test("new playback, season, provider checkpoint and library timestamps invalidate display", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  const altered = [
    { ...input, state: { ...input.state!, episode: 3 } },
    { ...input, state: { ...input.state!, timeOffset: 100 } },
    { ...input, state: { ...input.state!, video_id: "tt100:2:1" } },
    { ...input, state: { ...input.state!, lastWatched: "2026-11-14T03:00:00.000Z" } },
    { ...input, providerPlaybackIds: { simkl: "playback-2" } },
    { ...input, _mtime: "2026-11-14T03:00:00.000Z" },
    { ...input, altIds: ["tmdb:tv:21"] },
  ];
  for (const changed of altered) {
    const result = restoreCwDisplaySnapshot(owner, [changed as LibraryItem], {
      store: s,
      now: start + 1000,
    });
    assert.equal(result.advanced.size, 0);
  }
});

test("advanced presentation expires rather than becoming permanent watched state", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 29 * 60_000 }).advanced.size,
    1,
  );
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 31 * 60_000 }).advanced.size,
    0,
  );
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start - 1 }).advanced.size,
    0,
  );
});

test("verified removals have a shorter expiry and cannot hide changed checkpoints", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map(), new Set([input._id]), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 60_000 }).removed.has(
      input._id,
    ),
    true,
  );
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 3 * 60_000 }).removed.size,
    0,
  );
  const changed = { ...input, state: { ...input.state!, episode: 2 } } as LibraryItem;
  assert.equal(
    restoreCwDisplaySnapshot(owner, [changed], { store: s, now: start + 1000 }).removed.size,
    0,
  );
});

test("partial startup hydration retains an absent Simkl anime's verified next episode", () => {
  const s = store();
  const blackClover = {
    ...item("mal:61967", 3),
    upNext: true,
    state: {
      ...item("mal:61967", 3).state!,
      flaggedWatched: 1,
      timeOffset: 0,
    },
  } as LibraryItem;
  const e4 = {
    ...advanced(blackClover),
    state: {
      ...advanced(blackClover).state!,
      episode: 4,
      video_id: "mal:61967:1:4",
    },
  } as LibraryItem;
  const other = item("tt-other");
  saveCwDisplaySnapshot(owner, [blackClover], new Map([[blackClover._id, e4]]), new Set(), {
    store: s,
    now: start,
  });
  // Home can commit an unrelated partial row before the Simkl source arrives.
  saveCwDisplaySnapshot(owner, [other], new Map(), new Set(), {
    store: s,
    now: start + 1000,
  });
  const restored = restoreCwDisplaySnapshot(owner, [blackClover, other], {
    store: s,
    now: start + 2000,
  });
  assert.equal(restored.advanced.get(blackClover._id)?.state?.episode, 4);

  // Repeated partial passes must not extend the original 30-minute proof.
  saveCwDisplaySnapshot(owner, [other], new Map(), new Set(), {
    store: s,
    now: start + 29 * 60_000,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [blackClover], {
      store: s,
      now: start + 31 * 60_000,
    }).advanced.has(blackClover._id),
    false,
  );
});

test("an unresolved metadata request retains the same-checkpoint verified display", () => {
  const s = store();
  const blackClover = item("mal:61967", 3);
  saveCwDisplaySnapshot(
    owner,
    [blackClover],
    new Map([[blackClover._id, advanced(blackClover)]]),
    new Set(),
    {
      store: s,
      now: start,
    },
  );
  saveCwDisplaySnapshot(owner, [blackClover], new Map(), new Set(), {
    store: s,
    now: start + 1000,
    unresolvedIds: new Set([blackClover._id]),
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [blackClover], { store: s, now: start + 2000 }).advanced.get(
      blackClover._id,
    )?.state?.episode,
    2,
  );
  const changed = { ...blackClover, state: { ...blackClover.state!, episode: 4 } } as LibraryItem;
  assert.equal(
    restoreCwDisplaySnapshot(owner, [changed], { store: s, now: start + 2000 }).advanced.size,
    0,
  );
});

test("a later successful pass with no decisions replaces prior display results", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  saveCwDisplaySnapshot(owner, [input], new Map(), new Set(), { store: s, now: start + 1000 });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 2000 }).advanced.size,
    0,
  );
});

test("a partial pass cannot renew the expiry of a verified removal", () => {
  const s = store();
  const removed = item("tt-removed");
  saveCwDisplaySnapshot(owner, [removed], new Map(), new Set([removed._id]), {
    store: s,
    now: start,
  });
  saveCwDisplaySnapshot(owner, [item("tt-other")], new Map(), new Set(), {
    store: s,
    now: start + 90_000,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [removed], {
      store: s,
      now: start + 121_000,
    }).removed.has(removed._id),
    false,
  );
});

test("bad JSON and unavailable storage fail open to the live row", () => {
  const s = store();
  s.setItem("harbor:cw:validated-display:v1:" + owner, "{not-json");
  const missing = restoreCwDisplaySnapshot(owner, [item()], { store: s });
  assert.equal(missing.advanced.size, 0);
  assert.equal(missing.removed.size, 0);
  const broken = {
    getItem: (_: string): string | null => {
      throw new Error("storage denied");
    },
    setItem: (_: string, __: string) => {
      throw new Error("storage denied");
    },
  };
  assert.equal(restoreCwDisplaySnapshot(owner, [item()], { store: broken }).advanced.size, 0);
  assert.doesNotThrow(() =>
    saveCwDisplaySnapshot(owner, [item()], new Map(), new Set(), { store: broken }),
  );
});

test("future/invalid display coordinates never override real progress", () => {
  const s = store();
  const input = item();
  const output = advanced(input);
  output.state = { ...output.state!, season: -1 };
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, output]]), new Set(), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1 }).advanced.size,
    0,
  );
});

test("only completed, playable up-next results are persisted as early display decisions", () => {
  const s = store();
  const input = item();
  const paused = { ...advanced(input), upNext: false };
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, paused]]), new Set(), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1 }).advanced.size,
    0,
  );

  const offset = advanced(input);
  offset.state = { ...offset.state!, timeOffset: 2500 };
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, offset]]), new Set(), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1 }).advanced.size,
    0,
  );
});

test("restores a proven resurfaced card from the unchanged live source before a network pass", () => {
  const s = store();
  const source = item("tt200", 1);
  const output = advanced(source);
  const visible = item("tt100", 1);
  saveCwDisplaySnapshot(owner, [visible], new Map(), new Set(), {
    store: s,
    now: start,
    library: [visible, source],
    extra: [output],
  });
  const result = restoreCwDisplaySnapshot(owner, [visible], {
    store: s,
    now: start + 1000,
    library: [visible, source],
  });
  assert.equal(result.extra.length, 1);
  assert.equal(result.extra[0]._id, "tt200");
  assert.equal(result.extra[0].state?.episode, 2);
  assert.equal(result.extra[0].upNext, true);
  assert.deepEqual(result.extra[0].providerPlaybackIds, source.providerPlaybackIds);
});

test("a resurface snapshot cannot outlive a changed source, CW cohort, account or expiry", () => {
  const s = store();
  const source = item("tt200", 1);
  const visible = item("tt100", 1);
  saveCwDisplaySnapshot(owner, [visible], new Map(), new Set(), {
    store: s,
    now: start,
    library: [visible, source],
    extra: [advanced(source)],
  });
  const restore = (items: LibraryItem[], lib: LibraryItem[], key = owner, at = start + 1000) =>
    restoreCwDisplaySnapshot(key, items, { store: s, now: at, library: lib }).extra;
  assert.equal(
    restore([visible], [{ ...source, state: { ...source.state!, episode: 3 } } as LibraryItem])
      .length,
    0,
  );
  assert.equal(
    restore(
      [{ ...visible, state: { ...visible.state!, episode: 2 } } as LibraryItem],
      [visible, source],
    ).length,
    0,
  );
  assert.equal(restore([visible, source], [visible, source]).length, 0);
  assert.equal(
    restore([visible], [visible, source], cwDisplayOwnerKey(["another account"])).length,
    0,
  );
  assert.equal(restore([visible], [visible, source], owner, start + 3 * 60_000).length, 0);
  assert.equal(restore([visible], [visible]).length, 0);
});

test("advanced waiting displays without a next air date are rejected", () => {
  const s = store();
  const input = item();
  const invalid = {
    ...advanced(input),
    waitingForAir: true,
    nextAirDate: undefined,
  } as LibraryItem;
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, invalid]]), new Set(), {
    store: s,
    now: start,
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1000 }).advanced.size,
    0,
  );
});

test("resurfaced timer cards and unaired results are never restored", () => {
  const s = store();
  const source = item("tt200", 1);
  const visible = item("tt100", 1);
  const timer = {
    ...advanced(source),
    waitingForAir: true,
    nextAirDate: new Date(start + 60_000).toISOString(),
  };
  saveCwDisplaySnapshot(owner, [visible], new Map(), new Set(), {
    store: s,
    now: start,
    library: [visible, source],
    extra: [timer],
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [visible], {
      store: s,
      now: start + 1000,
      library: [visible, source],
    }).extra.length,
    0,
  );
  const future = {
    ...advanced(source),
    waitingForAir: false,
    nextAirDate: new Date(start + 60_000).toISOString(),
  };
  saveCwDisplaySnapshot(owner, [visible], new Map(), new Set(), {
    store: s,
    now: start,
    library: [visible, source],
    extra: [future],
  });
  assert.equal(
    restoreCwDisplaySnapshot(owner, [visible], {
      store: s,
      now: start + 1000,
      library: [visible, source],
    }).extra.length,
    0,
  );
});

test("empty or malformed resurface snapshots remain safe without live metadata", () => {
  const s = store();
  const visible = item();
  saveCwDisplaySnapshot(owner, [visible], new Map(), new Set(), { store: s, now: start });
  assert.deepEqual(restoreCwDisplaySnapshot(owner, [visible], { store: s, now: start }).extra, []);
  const key = [...s.data.keys()][0];
  const raw = JSON.parse(s.data.get(key)!);
  raw.extras = [{ id: "tt200", fingerprint: "invalid", display: {} }];
  s.setItem(key, JSON.stringify(raw));
  assert.deepEqual(
    restoreCwDisplaySnapshot(owner, [visible], { store: s, now: start, library: [item("tt200")] })
      .extra,
    [],
  );
});

test("an empty pre-hydration pass does not overwrite a validated display snapshot", () => {
  const s = store();
  const input = item();
  saveCwDisplaySnapshot(owner, [input], new Map([[input._id, advanced(input)]]), new Set(), {
    store: s,
    now: start,
  });
  const stored = [...s.data.values()][0];
  saveCwDisplaySnapshot(owner, [], new Map(), new Set(), {
    store: s,
    now: start + 500,
    library: [],
    extra: [],
  });
  assert.equal([...s.data.values()][0], stored);
  const restored = restoreCwDisplaySnapshot(owner, [input], { store: s, now: start + 1500 });
  assert.equal(restored.advanced.get(input._id)?.state?.episode, 2);
});
