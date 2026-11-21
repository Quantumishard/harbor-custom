import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createPluginStore } from "../src/lib/manga/plugins/store-factory.ts";

function load(file, dependencies, globals = {}) {
  const js = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), js)(
    (id) => {
      assert.ok(id in dependencies, "Unexpected dependency " + id);
      return dependencies[id];
    }, module, module.exports, ...Object.values(globals),
  );
  return module.exports;
}

function fakeDatabase() {
  const records = new Map();
  const db = {
    failDelete: false,
    transaction(_store, mode) {
      const tx = { error: null };
      tx.objectStore = () => ({
        getAll() {
          const req = {};
          queueMicrotask(() => {
            req.result = [...records.values()];
            req.onsuccess?.();
          });
          return req;
        },
        put(record) {
          assert.equal(mode, "readwrite");
          queueMicrotask(() => {
            records.set(record.id, record);
            tx.oncomplete?.();
          });
        },
        delete(id) {
          assert.equal(mode, "readwrite");
          queueMicrotask(() => {
            if (db.failDelete) {
              tx.error = new Error("IndexedDB transaction aborted");
              tx.onabort?.();
            } else {
              records.delete(id);
              tx.oncomplete?.();
            }
          });
        },
      });
      return tx;
    },
  };
  return {
    db, records,
    indexedDB: {
      open: () => {
        const req = { result: db };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    },
  };
}

function sourceHarness(store) {
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const disposed = [];
  const lifecycle = load("src/lib/manga/plugins/lifecycle.ts", {
    "./store": {
      savePlugin: store.savePlugin,
      deletePlugin: store.deletePlugin,
      installedPluginsSync: store.pluginsSync,
    },
    "./runtime": {
      disposePlugin: (id) => disposed.push(id),
      warmPlugin: () => {},
    },
  });
  const noopSub = () => () => {};
  const source = load("src/lib/manga/sources.ts", {
    "@/lib/storage-recovery": {
      setItemWithRecovery: (key, value) => { localStorage.setItem(key, value); return true; },
    },
    "./sources/aggregate": { aggregateProvider: {} },
    "./sources/suwayomi/provider": { makeSuwayomiProvider: () => ({ id: "suwayomi" }) },
    "./sources/local": { makeLocalProvider: () => ({ id: "local" }) },
    "./sources/html": { makeHtmlProvider: () => ({ id: "html" }) },
    "./community": { communityCatalog: () => [], refreshCommunityCatalog: async () => [], subscribeCommunity: noopSub },
    "./plugins/store": {
      installedPluginsSync: store.pluginsSync,
      subscribePlugins: store.subscribe,
      loadInstalledPlugins: store.loadPlugins,
    },
    "./plugins/lifecycle": lifecycle,
    "./plugins/runtime": { pluginProvider: (p) => ({ id: p.id }) },
    "./plugins/repos": { loadRepos: async () => [] },
    "./sources/mangayomi": { makeMangayomiProvider: () => ({}), removeMangayomiRecord: async () => {} },
    "./sources/mangayomi/store": {
      mangayomiSourcesSync: () => [], subscribeMangayomiSources: noopSub, loadMangayomiSources: async () => [],
    },
    "./sources/suwayomi/base-url": { credentialFreeBase: (s) => s, normalizeSuwayomiBase: (s) => s },
    "./sources/suwayomi/server-link": { reconcileSuwayomiServers: () => {} },
    "./sources/suwayomi/progress-bridge": { setSuwayomiBaseResolver: () => {} },
    "./sources/suwayomi/model": { makeServer: () => ({}) },
    "./sources/suwayomi/source-events": { subscribeSuwayomiSourcesChanged: noopSub },
  }, { localStorage });
  return { source, disposed, localStorage };
}

test("removing a Plugin source uninstalls it persistently and updates the active source", async () => {
  const originalDb = globalThis.indexedDB;
  const { db, records, indexedDB } = fakeDatabase();
  globalThis.indexedDB = indexedDB;
  try {
    const store = createPluginStore("manga-delete-success");
    await store.savePlugin({ id: "atsumaru", name: "Atsumaru", enabled: true });
    await store.savePlugin({ id: "batcave", name: "Batcave", enabled: true });
    const { source, disposed, localStorage } = sourceHarness(store);
    assert.deepEqual(source.listMangaSources().filter((s) => s.kind === "plugin").map((s) => s.id),
      ["atsumaru", "batcave"]);
    source.setActiveMangaSource("atsumaru");
    await source.removeMangaSource("atsumaru");
    assert.deepEqual(disposed, ["atsumaru"]);
    assert.equal(records.has("atsumaru"), false, "plugin must be removed from IndexedDB");
    assert.equal(localStorage.getItem("harbor.manga.activesource.v2"), "batcave");
    await store.loadPlugins();
    assert.deepEqual(source.listMangaSources().filter((s) => s.kind === "plugin").map((s) => s.id),
      ["batcave"], "reopening/reloading the list must not resurrect the plugin");
    await store.savePlugin({ id: "new-extension", name: "New extension", enabled: true });
    assert.ok(source.listMangaSources().some((s) => s.id === "new-extension"));
    assert.equal(db.failDelete, false);
  } finally {
    globalThis.indexedDB = originalDb;
  }
});

test("failed IndexedDB uninstall keeps the Plugin visible and reports the failure", async () => {
  const originalDb = globalThis.indexedDB;
  const { db, records, indexedDB } = fakeDatabase();
  globalThis.indexedDB = indexedDB;
  try {
    const store = createPluginStore("manga-delete-failure");
    await store.savePlugin({ id: "royalroad", name: "RoyalRoad", enabled: true });
    const { source } = sourceHarness(store);
    db.failDelete = true;
    await assert.rejects(source.removeMangaSource("royalroad"), /transaction aborted/);
    assert.equal(records.has("royalroad"), true);
    assert.ok(source.listMangaSources().some((s) => s.id === "royalroad"));
    await store.loadPlugins();
    assert.ok(source.listMangaSources().some((s) => s.id === "royalroad"));
  } finally {
    globalThis.indexedDB = originalDb;
  }
});
