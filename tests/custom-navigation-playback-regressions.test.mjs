import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isLivePlaybackSrc } from "../src/lib/player/live-src.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const load = (path, mocks = {}, storage) => {
  const code = ts.transpileModule(read(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "localStorage", code)(
    (id) => mocks[id] ?? {},
    exports,
    storage,
  );
  return exports;
};

test("retained root tabs have distinct React identities, including after resets", () => {
  const source = read("src/App.tsx");
  const keys = [
    ...source.matchAll(/key=\{"([^"]+)-" \+ \(viewResetVersions\["([^"]+)"\] \?\? 0\)\}/g),
  ];
  assert.ok(keys.length >= 20);
  assert.equal(new Set(keys.map((m) => m[1])).size, keys.length);
  for (const key of keys) assert.equal(key[1], key[2]);
  assert.doesNotMatch(source, /key=\{viewResetVersions\[/);
});

test("Easynews catalog files remain VOD while explicit broadcasts remain live", () => {
  for (const type of ["movie", "series", "tv", "channel"]) {
    assert.equal(
      isLivePlaybackSrc({ meta: { type, addonOrigin: { name: "Easynews Search" } } }),
      false,
    );
    assert.equal(
      isLivePlaybackSrc({ meta: { type }, streamRef: { addonId: "community.easynews" } }),
      false,
    );
  }
  assert.equal(isLivePlaybackSrc({ meta: { type: "tv" }, isLive: false }), false);
  assert.equal(isLivePlaybackSrc({ meta: { type: "tv" } }), true);
  assert.equal(
    isLivePlaybackSrc({ meta: { id: "iptv:fixture", type: "tv" }, isLive: false }),
    true,
  );
  assert.equal(isLivePlaybackSrc({ meta: { type: "movie" }, isLive: true }), true);
});

test("temporary browsing entries never enter Watchlist with bookmark filtering disabled", () => {
  const tab = load("src/views/library/watchlist-tab.tsx");
  const items = [
    { _id: "saved", removed: false, temp: false },
    { _id: "browsed", removed: false, temp: true },
  ];
  assert.deepEqual(
    tab.filterLibrary(items, false, "watchlist").map((x) => x._id),
    ["saved"],
  );
  assert.deepEqual(
    tab.filterLibrary(items, false, "library").map((x) => x._id),
    ["saved", "browsed"],
  );
});

for (const remote of [
  null,
  { removed: true, temp: false, _mtime: "2026-01-01" },
  { removed: false, temp: true, _mtime: "2026-01-01" },
  { removed: false, temp: false, _mtime: "2026-01-01" },
]) {
  test(`offline progress respects latest bookmark membership ${JSON.stringify(remote)}`, async () => {
    const writes = [];
    const data = new Map();
    let offline = true;
    const queue = load(
      "src/lib/stremio-write-queue.ts",
      {
        "@/lib/stremio": {
          libraryGetOneStrict: async () => remote,
          libraryPut: async (auth, item) => {
            if (offline) throw Error("offline");
            writes.push(item);
          },
        },
      },
      { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) },
    );
    await queue.cloudLibraryPut("fixture", {
      _id: "tt1",
      removed: false,
      temp: false,
      _mtime: "2026-01-02",
      state: { timeOffset: 60000 },
    });
    offline = false;
    await queue.flushWriteQueue();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].removed, remote?.removed ?? true);
    assert.equal(writes[0].temp, !remote || remote.removed || remote.temp);
    assert.equal(writes[0].state.timeOffset, 60000);
  });
}

test("non-browser-ready file URLs are not mistaken for live MPEG-TS", () => {
  const source = read("src/lib/player/html5/bridge.ts");
  const assignment = source.match(/isLiveSrc = src\.[^;]+;/)[0];
  const start = source.indexOf("      const bare = src.url.toLowerCase()");
  const end = source.indexOf("      if (isHls && Hls.isSupported())", start);
  const classify = new Function(
    "src",
    "let isLiveSrc;" + assignment + source.slice(start, end) + ";return {isLiveSrc,isTs,isHls};",
  );
  assert.deepEqual(
    classify({ url: "https://files.example/download/fixture", notWebReady: true, isLive: false }),
    { isLiveSrc: false, isTs: false, isHls: false },
  );
  assert.deepEqual(
    classify({ url: "https://tv.example/channel", notWebReady: true, isLive: true }),
    { isLiveSrc: true, isTs: true, isHls: false },
  );
  assert.deepEqual(classify({ url: "https://files.example/movie.ts", isLive: false }), {
    isLiveSrc: false,
    isTs: true,
    isHls: false,
  });
});

for (const membership of [
  null,
  { removed: true, temp: false },
  { removed: false, temp: true },
  { removed: false, temp: false },
]) {
  test(`active progress respects fresh bookmark membership ${JSON.stringify(membership)}`, async () => {
    const writes = [];
    const code = ts.transpileModule(
      read("src/views/player/hooks/use-stremio-sync.ts").replaceAll(
        "import.meta.env",
        "({DEV:false})",
      ) + "\nexport {writeLibraryItem};",
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    const mocks = {
      "@/lib/stremio": { libraryGetOneStrict: async () => membership },
      "@/lib/stremio-item-lock": { withItemLock: async (id, fn) => fn() },
      "@/lib/stremio-write-queue": {
        cloudLibraryPut: async (auth, item) => {
          writes.push(item);
          return true;
        },
      },
    };
    const exports = {};
    new Function("require", "exports", code)((id) => mocks[id] ?? {}, exports);
    await exports.writeLibraryItem(
      "fixture",
      { meta: { id: "tt1", name: "Fixture", type: "movie" } },
      { durationSec: 3600, status: "playing" },
      { _id: "tt1", removed: false, temp: false, state: {} },
      "tt1",
      300,
      false,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].removed, !membership || membership.removed || membership.temp);
    assert.equal(writes[0].temp, !membership || membership.removed || membership.temp);
    assert.equal(writes[0].state.timeOffset, 300000);
  });
}
