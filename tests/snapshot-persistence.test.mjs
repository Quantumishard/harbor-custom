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
function load(file, store, mocks = {}) {
  const code = ts.transpileModule(
    readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const api = {};
  new Function("require", "exports", "localStorage", code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    api,
    store,
  );
  return api;
}
function snapshots(store) {
  return load("snapshots", store, {
    react: {},
    "./storage-recovery": load("storage-recovery", store),
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
