import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  let key = "rfk_original";
  let profile = "primary";
  let primary = true;
  let enabled = true;
  const writes = [];
  const source = readFileSync(new URL("../src/lib/watchlist.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const mocks = {
    react: {},
    "@/lib/nuvio/nuvio-sync": { isNuvioProviderActive: () => false },
    "@/lib/active-profile-id": {
      activeScopedProfileId: () => profile,
      activeProfileIsPrimary: () => primary,
    },
    "@/lib/refract/client": {
      getRefractKey: () => key,
      refractEnabled: () => enabled,
      syncRefractWatchlist: async (account, input, on, assertCurrent) => {
        assertCurrent();
        await Promise.resolve();
        assertCurrent();
        writes.push({ account, input, on });
      },
    },
  };
  new Function("require", "module", "exports", output)(
    (name) => mocks[name] ?? {},
    module,
    module.exports,
  );
  return {
    prepare: module.exports.prepareRefractLibraryRemoval,
    writes,
    setKey: (value) => {
      key = value;
    },
    setProfile: (value) => {
      profile = value;
    },
    setPrimary: (value) => {
      primary = value;
    },
    setEnabled: (value) => {
      enabled = value;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Library removal syncs Refract Plan to Watch removal with the captured account", async () => {
  const h = harness();
  const finish = h.prepare({ id: "tmdb:movie:55", type: "movie", imdbId: "tt55" });
  finish();
  await tick();
  assert.deepEqual(h.writes, [
    {
      account: "rfk_original",
      input: { id: "tmdb:movie:55", type: "movie", imdbId: "tt55" },
      on: false,
    },
  ]);
});

test("Library removal cannot send to a replacement Refract account or profile", async () => {
  const h = harness();
  const first = h.prepare({ id: "tt101", type: "movie" });
  h.setKey("rfk_replacement");
  first();
  await tick();
  assert.equal(h.writes.length, 0);

  const second = h.prepare({ id: "tt102", type: "series" });
  h.setProfile("secondary");
  second();
  await tick();
  assert.equal(h.writes.length, 0);
});

test("Library removal is excluded for disabled Refract and secondary profiles", async () => {
  const h = harness();
  h.setPrimary(false);
  const fromSecondary = h.prepare({ id: "tt101", type: "movie" });
  h.setPrimary(true);
  fromSecondary();
  h.setEnabled(false);
  h.prepare({ id: "tt102", type: "series" })();
  await tick();
  assert.equal(h.writes.length, 0);
});

test("Library removal revalidates the account during an asynchronous lookup", async () => {
  const h = harness();
  const finish = h.prepare({ id: "tt101", type: "movie" });
  finish();
  h.setKey("rfk_replacement");
  await tick();
  assert.equal(h.writes.length, 0);
});

test("Library Stremio, Nuvio and local removals all dispatch the captured Refract removal", () => {
  const source = readFileSync(
    new URL("../src/views/library/watchlist-tab.tsx", import.meta.url),
    "utf8",
  );
  const removeStart = source.indexOf("const handleRemove =");
  const localStart = source.indexOf("const handleRemoveLocal");
  const localEnd = source.indexOf("useEffect(() => {", localStart);
  const remove = source.slice(removeStart, localStart);
  const local = source.slice(localStart, localEnd);
  assert.equal(
    (remove.match(/prepareRefractLibraryRemoval\(/g) || []).length,
    2,
    "Nuvio and Stremio removals must both capture the Refract account",
  );
  assert.equal(
    (remove.match(/syncRefractRemoval\(\)/g) || []).length,
    2,
    "Nuvio and Stremio removals must both trigger Refract synchronization",
  );
  assert.equal(
    (local.match(/syncRefractRemoval\(\)/g) || []).length,
    2,
    "local removals must trigger Refract in both provider modes",
  );
  assert.match(
    remove,
    /for \(const l of twins\) removeFromWatchlist\(l.id\);\s*syncRefractRemoval\(\)/,
  );
});
