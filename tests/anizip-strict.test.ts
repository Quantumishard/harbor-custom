// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

type FetchResult = { ok: boolean; status: number; json: () => Promise<unknown> };

function load(options: { fetch: () => Promise<FetchResult>; stored?: any; addonOnly?: boolean }) {
  const source = readFileSync(new URL("../src/lib/providers/anizip.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", code)((id: string) => {
    if (id === "@/lib/metadata-policy")
      return { addonOnlyMetadata: () => options.addonOnly === true };
    if (id === "@/lib/safe-fetch") return { safeFetch: () => options.fetch() };
    if (id === "@/lib/anime-cw-ids") return { recordAnimeCwId() {}, recordAnilistMalAlias() {} };
    if (id === "@/lib/anime-identity-db")
      return {
        animeDbReadProvider: async () => options.stored ?? null,
        animeDbWriteProvider: async () => true,
        animeDbWriteEntries: () => {},
        animeDbWriteEpisodes: () => {},
      };
    assert.fail(`Unexpected import: ${id}`);
  }, exports);
  return exports as {
    aniZipByImdb: (
      id: string,
      identity?: boolean,
      maxAge?: number,
      strict?: boolean,
    ) => Promise<any>;
  };
}

const mapping = { mappings: { kitsu_id: 1 }, episodes: { "1": { episodeNumber: 1 } } };

test("a 5xx is unavailable for strict callers and null for best effort", async () => {
  const api = load({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(api.aniZipByImdb("tt100", true, undefined, true), /unavailable/);
  assert.equal(await api.aniZipByImdb("tt100", true), null);
});

test("a network failure is unavailable for strict callers", async () => {
  const api = load({
    fetch: async () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(api.aniZipByImdb("tt101", true, undefined, true), /unavailable/);
  assert.equal(await api.aniZipByImdb("tt101", true), null);
});

test("a 404 stays a legitimate no-mapping answer for strict callers", async () => {
  const api = load({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(await api.aniZipByImdb("tt102", true, undefined, true), null);
});

test("a known-good stored mapping survives an outage for strict callers", async () => {
  const api = load({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    stored: { value: mapping, expiresAt: Date.now() - 1000, fetchedAt: Date.now() - 60_000 },
  });
  assert.deepEqual(await api.aniZipByImdb("tt103", true, undefined, true), mapping);
});

test("best-effort and strict callers share one request without sharing its policy", async () => {
  let release!: (result: FetchResult) => void;
  const gate = new Promise<FetchResult>((resolve) => {
    release = resolve;
  });
  const api = load({ fetch: () => gate });
  const best = api.aniZipByImdb("tt200", true);
  const strict = api.aniZipByImdb("tt200", true, undefined, true);
  release({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await best, null);
  await assert.rejects(strict, /unavailable/);
});

test("a strict caller starting the request does not make best effort throw", async () => {
  let release!: (result: FetchResult) => void;
  const gate = new Promise<FetchResult>((resolve) => {
    release = resolve;
  });
  const api = load({ fetch: () => gate });
  const strict = api.aniZipByImdb("tt201", true, undefined, true);
  const best = api.aniZipByImdb("tt201", true);
  release({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(strict, /unavailable/);
  assert.equal(await best, null);
});

test("addon-only metadata still allows a strict identity lookup", async () => {
  let calls = 0;
  const api = load({
    addonOnly: true,
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => mapping };
    },
  });
  // Refusing to ask is not proof there is no mapping.
  assert.equal(await api.aniZipByImdb("tt300"), null);
  assert.equal(calls, 0);
  assert.deepEqual(await api.aniZipByImdb("tt300", false, undefined, true), mapping);
  assert.equal(calls, 1);
});

test("both callers share a stored mapping during an outage", async () => {
  let release!: (result: FetchResult) => void;
  const gate = new Promise<FetchResult>((resolve) => {
    release = resolve;
  });
  const api = load({
    fetch: () => gate,
    stored: { value: mapping, expiresAt: Date.now() - 1000, fetchedAt: Date.now() - 60_000 },
  });
  const best = api.aniZipByImdb("tt202", true);
  const strict = api.aniZipByImdb("tt202", true, undefined, true);
  release({ ok: false, status: 503, json: async () => ({}) });
  assert.deepEqual(await best, mapping);
  assert.deepEqual(await strict, mapping);
});
