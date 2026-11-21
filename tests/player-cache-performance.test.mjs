import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(file, storage, fetcher, idb = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  let parses = 0;
  const json = {
    parse: (...args) => {
      parses++;
      return JSON.parse(...args);
    },
    stringify: JSON.stringify,
  };
  new Function("require", "exports", "localStorage", "fetch", "JSON", code)(
    () => ({
      mappingStore: () => ({}),
      privateCwProfileId: () => "",
      isNuvioProviderActive: () => false,
      getNuvioActiveSlot: () => 1,
      animeDbReadProvider: idb.read ?? (async () => null),
      animeDbWriteProvider: idb.write ?? (async () => false),
    }),
    api,
    storage,
    fetcher,
    json,
  );
  return { api, parses: () => parses };
}

test("anime mappings remain cached when persistent storage rejects the write", async () => {
  let downloads = 0;
  let persistentWrites = 0;
  const h = load(
    "../src/lib/providers/anime-mapping.ts",
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
    async () => {
      downloads++;
      return { ok: true, text: async () => '<anime anidbid="1" tvdbid="2" defaulttvdbseason="1">' };
    },
    {
      write: async () => {
        persistentWrites++;
        return false;
      },
    },
  );
  const first = await h.api.loadAnidbMaps();
  for (let i = 0; i < 100; i++) assert.equal(await h.api.loadAnidbMaps(), first);
  assert.equal(first.tvdb["1"], 2);
  assert.equal(downloads, 1);
  assert.equal(persistentWrites, 1);
});

test("failed anime requests share an inflight request and back off", async () => {
  let downloads = 0;
  const h = load("../src/lib/providers/anime-mapping.ts", { getItem: () => null }, async () => {
    downloads++;
    throw new Error("offline");
  });
  await Promise.all(Array.from({ length: 100 }, () => h.api.loadAnidbMaps()));
  await h.api.loadAnidbMaps();
  assert.equal(downloads, 1);
});

test("resume reads parse each unchanged storage source only once while observing updates", () => {
  let raw = JSON.stringify({ movie: { ms: 123, t: 1 } });
  const keysRead = new Set();
  const h = load("../src/lib/resume.ts", {
    getItem: (key) => {
      keysRead.add(key);
      return key === "harbor.resume" ? raw : null;
    },
    setItem: (key, value) => {
      assert.equal(key, "harbor.resume");
      raw = value;
    },
  });
  for (let i = 0; i < 1000; i++) assert.equal(h.api.readResumeEntry("movie").ms, 123);
  assert.deepEqual([...keysRead].sort(), ["harbor.profiles.v1", "harbor.resume"]);
  assert.equal(h.parses(), 2, "one profile roster lookup and one resume parse for 1000 reads");
  raw = JSON.stringify({ movie: { ms: 456, t: 2 } });
  assert.equal(h.api.readResumeMs("movie"), 456);
  h.api.saveResumeMs("movie", 789);
  assert.equal(h.api.readResumeMs("movie"), 789);
  assert.equal(h.parses(), 3, "only the changed resume value is reparsed");
  raw = null;
  assert.equal(h.api.readResumeEntry("movie"), null);
  assert.equal(h.parses(), 3, "removing resume data does not reparse the profile roster");
});
