import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(file, globals = {}) {
  const code = ts.transpileModule(
    readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api = {};
  new Function("exports", ...Object.keys(globals), code)(api, ...Object.values(globals));
  return api;
}

test("title search scans all pages using raw offsets, matches only name, and reuses its index", async () => {
  const { CatalogTitleIndex } = load("catalog-title-search");
  const calls = [];
  const pages = [
    [
      { id: "1", name: "First Title", description: "Needle" },
      { id: "2", name: "The Needle" },
    ],
    [
      { id: "2", name: "The Needle" },
      { id: "3", name: "NEEDLE in a haystack" },
    ],
    [{ id: "4", name: "Needle finale" }],
    [],
  ];
  const index = new CatalogTitleIndex(async (page, loaded) => {
    calls.push([page, loaded]);
    return pages[page - 1];
  });
  while (!index.complete) await index.next();
  assert.deepEqual(calls, [
    [1, 0],
    [2, 2],
    [3, 4],
    [4, 5],
  ]);
  assert.deepEqual(
    index.search(" needle ").map((m) => m.id),
    ["2", "3", "4"],
  );
  assert.deepEqual(
    index.search("First").map((m) => m.id),
    ["1"],
  );
  await index.next();
  assert.equal(calls.length, 4);
});

test("repeating catalog pages cannot produce a false full-catalog result", async () => {
  const { CatalogTitleIndex } = load("catalog-title-search");
  const index = new CatalogTitleIndex(async () => [{ id: "1", name: "A" }]);
  await index.next();
  await assert.rejects(index.next(), /repeated a page/);
  assert.equal(index.complete, false);
});

test("cancel and immediate retry share the in-flight catalog page", async () => {
  const { CatalogTitleIndex } = load("catalog-title-search");
  let resolve,
    calls = 0;
  const index = new CatalogTitleIndex(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const a = index.next(),
    b = index.next();
  resolve([{ id: "1", name: "A" }]);
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(index.size, 1);
});

test("episode stills try TMDB then the alternate URL and catalog thumbnail without duplicates", () => {
  const { episodeImageCandidates } = load("episode-images");
  assert.deepEqual(
    episodeImageCandidates(
      { stillPath: "/valid.jpg", stillUrl: "https://alternate/still.jpg" },
      "https://catalog/still.jpg",
    ),
    [
      "https://image.tmdb.org/t/p/w300/valid.jpg",
      "https://alternate/still.jpg",
      "https://catalog/still.jpg",
    ],
  );
  assert.deepEqual(
    episodeImageCandidates(
      { stillPath: "https://same/still.jpg", stillUrl: "https://same/still.jpg" },
      "https://same/still.jpg",
    ),
    ["https://same/still.jpg"],
  );
  assert.deepEqual(
    episodeImageCandidates({ stillPath: null, stillUrl: "https://alternate/still.jpg" }),
    ["https://alternate/still.jpg"],
  );
  assert.deepEqual(episodeImageCandidates({ stillPath: "/hd.jpg" }, undefined, true), [
    "https://image.tmdb.org/t/p/original/hd.jpg",
  ]);
});

// Transaction completion is separate from request success, as in IndexedDB.
function durableStorage() {
  const records = new Map();
  let chain = Promise.resolve();
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = db;
        request.onsuccess();
      });
      return request;
    },
  };
  const db = {
    transaction() {
      let release;
      const previous = chain;
      chain = new Promise((done) => {
        release = done;
      });
      const tx = {
        objectStore() {
          return {
            getAll: () => operation(() => [...records.values()]),
            get: (id) => operation(() => records.get(id)),
            put: (frame) =>
              operation(() => {
                records.set(frame.id, structuredClone(frame));
                return frame.id;
              }),
            delete: (id) => operation(() => records.delete(id)),
            clear: () => operation(() => records.clear()),
          };
        },
      };
      let pending = 0;
      function operation(fn) {
        pending++;
        const request = {};
        previous.then(() => {
          request.result = fn();
          request.onsuccess?.();
          if (--pending === 0)
            queueMicrotask(() => {
              tx.oncomplete?.();
              release();
            });
        });
        return request;
      }
      return tx;
    },
  };
  return { indexedDB, records };
}
const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

test("saved frames survive a new session without localStorage and retain aliases", async () => {
  const disk = durableStorage();
  const first = load("snapshot-store", disk);
  first.storeSavedFrame({ id: "tt1", aliases: ["tmdb:1"], t: 100, image: "captured-frame" });
  await settle();
  const restarted = load("snapshot-store", disk);
  let notified = false;
  restarted.hydrateSavedFrames(() => {
    notified = true;
  });
  await settle();
  assert.equal(notified, true);
  assert.equal(restarted.savedFrame("tmdb:1").image, "captured-frame");
  restarted.pruneSavedFrames(101);
  await settle();
  assert.equal(disk.records.size, 0);
});

test("startup hydration and legacy migration cannot overwrite a newer saved frame", async () => {
  const disk = durableStorage();
  disk.records.set("tt1", { id: "tt1", t: 200, image: "new" });
  const api = load("snapshot-store", disk);
  api.hydrateSavedFrames(() => {});
  api.storeSavedFrame({ id: "tt1", t: 100, image: "old-localStorage" });
  await settle();
  assert.equal(api.savedFrame("tt1").image, "new");
  assert.equal(disk.records.get("tt1").image, "new");
});

test("clearing during startup cannot resurrect frames", async () => {
  const disk = durableStorage();
  disk.records.set("tt1", { id: "tt1", t: 200, image: "old" });
  const api = load("snapshot-store", disk);
  api.hydrateSavedFrames(() => {});
  api.clearSavedFrames();
  await settle();
  assert.equal(api.savedFrame("tt1"), undefined);
  assert.equal(disk.records.size, 0);
});
