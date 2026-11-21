import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const SHARED_PREFIX = "harbor.localcw.v1.";
const PRIVATE_PREFIX = "harbor.localcw.private.v1.";

function harness(opts: { privateId?: string | null; nuvio?: boolean; activeId?: string } = {}) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  const window = { addEventListener: () => {} };
  const full = resolve("src/lib/local-cw.ts");
  const compiled = ts.transpileModule(readFileSync(full, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "localStorage", "window", compiled)(
    (name: string) => {
      if (name === "./cw-profile") {
        return {
          privateCwProfileId: () => (opts.privateId === undefined ? null : opts.privateId),
          cwProfileScope: () => ({
            profileId: opts.activeId ?? "a",
            sharedId: opts.activeId ?? "a",
            private: !!opts.privateId,
          }),
        };
      }
      if (name === "./active-profile-id") {
        return {
          isNuvioProviderActive: () => opts.nuvio ?? false,
          getNuvioActiveSlot: () => 1,
        };
      }
      throw new Error(`Unexpected dependency ${name}`);
    },
    exports,
    storage,
    window,
  );
  return { data, api: exports as any, storage };
}

type Entry = {
  id: string;
  type: "movie" | "series";
  name: string;
  positionMs: number;
  durationMs: number;
  t: number;
  season?: number;
  episode?: number;
  external?: string;
};

function entry(id: string, t: number, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    type: "series",
    name: id,
    positionMs: 0,
    durationMs: 0,
    t,
    ...overrides,
  };
}

function seed(
  h: ReturnType<typeof harness>,
  rows: { shared?: Entry[]; private?: Entry[] },
  activeId = "a",
): void {
  if (rows.shared)
    h.data.set(
      SHARED_PREFIX + activeId,
      JSON.stringify(Object.fromEntries(rows.shared.map((row) => [row.id, row]))),
    );
  if (rows.private)
    h.data.set(
      PRIVATE_PREFIX + activeId,
      JSON.stringify(Object.fromEntries(rows.private.map((row) => [row.id, row]))),
    );
}

test("the newer private checkpoint surfaces over a stale shared row", () => {
  const h = harness();
  seed(h, {
    shared: [
      entry("kitsu:49847", 1_000, { positionMs: 29, durationMs: 100, season: 6, episode: 9 }),
    ],
    private: [
      entry("kitsu:49847", 2_000, { positionMs: 97, durationMs: 100, season: 6, episode: 9 }),
    ],
  });

  // The old reader only sees the shared store.
  assert.equal(h.api.listLocalCw(false)[0].positionMs, 29);

  const merged = h.api.listLocalCwMerged(false);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].positionMs, 97);
});

test("a private-only card is visible in the shared row", () => {
  const h = harness();
  seed(h, {
    shared: [entry("tt100", 1_000)],
    private: [entry("kitsu:49847", 2_000, { season: 6, episode: 9 })],
  });

  assert.deepEqual(
    h.api.listLocalCw(false).map((row: Entry) => row.id),
    ["tt100"],
  );
  assert.deepEqual(
    h.api.listLocalCwMerged(false).map((row: Entry) => row.id),
    ["kitsu:49847", "tt100"],
  );
});

test("a private scope still never reads shared rows", () => {
  const h = harness({ privateId: "a" });
  seed(h, {
    shared: [entry("shared-only", 5_000)],
    private: [entry("private-only", 1_000)],
  });

  assert.deepEqual(
    h.api.listLocalCwMerged(true).map((row: Entry) => row.id),
    ["private-only"],
  );
});

test("localCwEntryMerged returns the newest checkpoint per id", () => {
  const h = harness();
  seed(h, {
    shared: [entry("tt1", 3_000, { positionMs: 10 })],
    private: [entry("tt1", 1_000, { positionMs: 90 })],
  });

  assert.equal(h.api.localCwEntryMerged("tt1", false)?.positionMs, 10);
  assert.equal(h.api.localCwEntryMerged("missing", false), null);
});
