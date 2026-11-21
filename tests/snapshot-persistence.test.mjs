import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function storage(limit = Infinity) {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
    setItem(key, value) {
      const next = new Map(data).set(key, String(value));
      if ([...next].reduce((sum, [k, v]) => sum + k.length + v.length, 0) > limit)
        throw new DOMException("Full", "QuotaExceededError");
      data.set(key, String(value));
    },
  };
}
function load(file, store, mocks = {}, durable = false) {
  const code = ts.transpileModule(
    readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const api = {};
  new Function("require", "exports", "localStorage", "indexedDB", code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    api,
    store,
    durable ? {} : undefined,
  );
  return api;
}
function snapshots(store) {
  return load("snapshots", store, {
    react: {},
    "./storage-recovery": load("storage-recovery", store),
    "./snapshot-store": {
      hydrateSavedFrames() {},
      savedFrame() {},
      savedFrameIds() {
        return [];
      },
      storeSavedFrame() {},
      pruneSavedFrames() {},
      clearSavedFrames() {},
    },
  });
}

test("first captured frame recovers a full cache and survives restart under either title ID", () => {
  const store = storage(2000);
  store.setItem("harbor.settings", "keep-settings");
  store.setItem("harbor.bookmarks", "keep-bookmarks");
  store.setItem("harbor.omdb.v1", "x".repeat(1500));
  const frame = "data:image/jpeg;base64," + "a".repeat(900);
  assert.equal(snapshots(store).saveSnapshot("tt123", frame, ["tmdb:123"]), true);
  assert.equal(store.getItem("harbor.omdb.v1"), null);
  const restarted = snapshots(store);
  assert.equal(restarted.readSnapshot("tt123"), frame);
  assert.equal(restarted.readSnapshot("tmdb:123"), frame);
  assert.equal(restarted.snapshotCount(), 1);
  assert.equal(store.getItem("harbor.settings"), "keep-settings");
  assert.equal(store.getItem("harbor.bookmarks"), "keep-bookmarks");
});

test("failed oversized replacement preserves the previously saved frame", () => {
  const store = storage(1000),
    api = snapshots(store);
  assert.equal(api.saveSnapshot("tt123", "old-frame", ["tmdb:123"]), true);
  assert.equal(api.saveSnapshot("tt123", "x".repeat(2000), ["tmdb:123"]), false);
  assert.equal(snapshots(store).readSnapshot("tmdb:123"), "old-frame");
});

test("a fresh canonical capture replaces an older frame saved under the original title ID", () => {
  const store = storage(),
    api = snapshots(store);
  api.saveSnapshot("tmdb:123", "old-frame");
  api.saveSnapshot("tt123", "new-frame", ["tmdb:123"]);
  assert.equal(snapshots(store).readSnapshot("tmdb:123"), "new-frame");
});

test("turning snapshots off removes canonical frames and aliases", () => {
  const store = storage(),
    api = snapshots(store);
  api.saveSnapshot("tt123", "frame", ["tmdb:123"]);
  api.setSnapshotRetentionDays(0);
  assert.equal(api.readSnapshot("tmdb:123"), null);
  assert.equal(store.getItem("harbor.snap.tt123"), null);
  assert.equal(api.saveSnapshot("tt456", "frame"), false);
});

test("Continue Watching still reads a durable frame after unrelated storage recovery evicts its local copy", () => {
  const store = storage();
  const frames = new Map();
  const durable = {
    hydrateSavedFrames() {},
    savedFrame: (id) =>
      [...frames.values()].find((frame) => frame.id === id || frame.aliases?.includes(id)),
    savedFrameIds: () => [...frames.keys()],
    storeSavedFrame: (frame) => frames.set(frame.id, frame),
    pruneSavedFrames() {},
    clearSavedFrames: () => frames.clear(),
  };
  const boot = () =>
    load(
      "snapshots",
      store,
      {
        react: {},
        "./storage-recovery": load("storage-recovery", store),
        "./snapshot-store": durable,
      },
      true,
    );
  boot().saveSnapshot("tt123", "captured-frame", ["tmdb:123"]);
  store.removeItem("harbor.snap.tt123");
  const restarted = boot();
  assert.equal(restarted.readSnapshot("tmdb:123"), "captured-frame");
  assert.equal(restarted.snapshotCount(), 1);
  restarted.clearAllSnapshots();
  assert.equal(restarted.readSnapshot("tmdb:123"), null);
});

test("all legacy frames migrate before the local snapshot budget evicts old titles", () => {
  const store = storage();
  store.setItem("harbor.snap.ttOld", "legacy-frame");
  store.setItem("harbor.snap.index", JSON.stringify([{ id: "ttOld", t: Date.now() }]));
  const frames = new Map();
  const api = load(
    "snapshots",
    store,
    {
      react: {},
      "./storage-recovery": load("storage-recovery", store),
      "./snapshot-store": {
        hydrateSavedFrames() {},
        savedFrame: (id) => frames.get(id),
        savedFrameIds: () => [...frames.keys()],
        storeSavedFrame: (frame) => frames.set(frame.id, frame),
        pruneSavedFrames() {},
        clearSavedFrames() {},
      },
    },
    true,
  );
  api.saveSnapshot("ttNew", "x".repeat(3 * 1024 * 1024));
  assert.equal(store.getItem("harbor.snap.ttOld"), null);
  assert.equal(api.readSnapshot("ttOld"), "legacy-frame");
});
