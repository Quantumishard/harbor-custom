import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  const records = new Map<string, { value: any; until: number }>();
  let config = JSON.stringify({ language: "en", addonOnlyMetadata: false });
  let now = 1_000_000;
  let generation = 0;
  let reads = 0;
  let source: () => Promise<any[]> = async () => [{ season: 1, episode: 1, airDate: "2020-01-01" }];
  let lastOptions: any;
  let installed: any[] = [];
  let disabled: string[] = [];
  let language = "en";
  const mocks: Record<string, any> = {
    "@/lib/addon-store": {
      loadInstalled: () => installed,
      loadDisabledAddons: () => new Set(disabled),
    },
    "@/lib/addons-store/reorder": { loadDisplayOrder: () => [] },
    "@/lib/providers/tmdb/tmdb-client": { effectiveTmdbLanguage: () => language },
    "@/lib/series-episodes": {
      EpisodeListUnavailableError: class EpisodeListUnavailableError extends Error {},
      fetchEpisodeList: async (_meta: any, opts: any) => {
        reads++;
        lastOptions = opts;
        return source();
      },
    },
    "@/lib/media-cache": {
      MEDIA_TTL: { episodes: 5_000, stale: 30_000 },
      episodeCacheTtl: () => 2_000,
      mediaCacheGeneration: () => generation,
      loadMedia: async (namespace: string, scope: any[], loader: () => Promise<any[]>, policy: any) => {
        const key = JSON.stringify([namespace, scope]);
        const stored = records.get(key);
        if (stored && stored.until > now && policy.valid(stored.value))
          return { value: stored.value };
        try {
          const value = await loader();
          if (!policy.valid(value)) return { value: null };
          records.set(key, { value, until: now + policy.ttl(value) });
          return { value };
        } catch {
          // Emulates the disk cache: rejected refreshes must not return stale
          // data to an advancement caller when fallbackOnError is false.
          assert.equal(policy.fallbackOnError, false);
          assert.equal(policy.staleWhileRevalidate, false);
          return { value: null };
        }
      },
    },
  };
  const sourceText = readFileSync("src/lib/cw-episode-list-cache.ts", "utf8");
  const code = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const createCaller = (): any => {
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "localStorage", code)(
      (name: string) => {
        assert.ok(name in mocks, "unexpected dependency " + name);
        return mocks[name];
      },
      module,
      module.exports,
      { getItem: () => config },
    );
    return module.exports;
  };
  let api = createCaller();
  const meta = { id: "anilist:20513", type: "series", name: "Psycho-Pass 2" };
  const request = (owner = "owner-A", id = meta.id, signal = new AbortController().signal) =>
    api.fetchCachedCwEpisodeList({ ...meta, id }, { tmdbKey: "test-key", signal }, owner);
  return {
    request,
    reopen: () => { api = createCaller(); },
    get reads() { return reads; },
    get lastOptions() { return lastOptions; },
    setConfig: (settings: object) => { config = JSON.stringify(settings); },
    setInstalled: (items: any[]) => { installed = items; },
    setDisabled: (urls: string[]) => { disabled = urls; },
    setLanguage: (next: string) => { language = next; },
    setSource: (fn: () => Promise<any[]>) => { source = fn; },
    advance: (ms: number) => { now += ms; },
    clear: () => { records.clear(); generation++; },
    bumpGeneration: () => { generation++; },
  };
}

test("completed CW lists survive a recreated caller and remain owner/content scoped", async () => {
  const h = harness();
  const first = await h.request();
  assert.equal(h.reads, 1);
  assert.equal(h.lastOptions.requireComplete, true);
  h.reopen(); // New module instance, same durable backing store.
  assert.deepEqual(await h.request(), first);
  assert.equal(h.reads, 1, "a repeated launch should reuse the verified episode list");
  await h.request("owner-B");
  await h.request("owner-A", "anilist:another");
  assert.equal(h.reads, 3, "another account or content id must not reuse this list");
});

test("unrelated settings rewrites do not invalidate episode lists, but metadata changes do", async () => {
  const h = harness();
  await h.request();
  h.reopen();
  h.setConfig({ language: "ja", theme: "dark", startupTime: Date.now() });
  await h.request();
  assert.equal(h.reads, 1, "startup-rewritten preferences caused a needless new list");
  h.setConfig({ metadataSources: { episodes: ["tmdb"] } });
  await h.request();
  assert.equal(h.reads, 2, "episode provider change failed to invalidate the list");
  h.setLanguage("ja");
  await h.request();
  assert.equal(h.reads, 3, "metadata language change failed to invalidate the list");
  h.setInstalled([{ id: "a", transportUrl: "https://example.org", manifest: { id: "a", version: "1" } }]);
  await h.request();
  assert.equal(h.reads, 4, "installed addon change failed to invalidate the list");
  h.setDisabled(["https://example.org"]);
  await h.request();
  assert.equal(h.reads, 5, "addon enablement change failed to invalidate the list");
});

test("an expired list must revalidate and a provider outage must never reuse stale finale data", async () => {
  const h = harness();
  await h.request();
  h.advance(2_001);
  h.setSource(async () => { throw new Error("offline"); });
  await assert.rejects(h.request());
  assert.equal(h.reads, 2, "the stale list was incorrectly treated as current");
  h.setSource(async () => [{ season: 1, episode: 2 }]);
  assert.equal((await h.request())[0].episode, 2);
  assert.equal(h.reads, 3);
});

test("empty or malformed provider lists are not cached as completion proof", async () => {
  const h = harness();
  h.setSource(async () => []);
  await assert.rejects(h.request());
  h.setSource(async () => [{ season: 1, episode: -1 }]);
  await assert.rejects(h.request());
  h.setSource(async () => [{ season: 1, episode: 1 }]);
  assert.equal((await h.request()).length, 1);
  assert.equal(h.reads, 3);
});

test("season-zero specials and episode-zero metadata remain cacheable", async () => {
  const h = harness();
  h.setSource(async () => [{ season: 0, episode: 0 }, { season: 1, episode: 1 }]);
  const first = await h.request();
  h.reopen();
  assert.deepEqual(await h.request(), first);
  assert.equal(h.reads, 1, "valid specials caused a repeated metadata fetch");
});

test("addon-only configuration bypasses assembled-list persistence", async () => {
  const h = harness();
  h.setConfig({ addonOnlyMetadata: true });
  await h.request();
  await h.request();
  assert.equal(h.reads, 2);
  assert.equal(h.lastOptions.requireComplete, true);
});

test("cleared or aborted cache work cannot replay an obsolete episode list", async () => {
  const h = harness();
  await h.request();
  h.clear();
  await h.request();
  assert.equal(h.reads, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.request("owner-A", "anilist:20513", controller.signal), /abort/i);
  assert.equal(h.reads, 2);

  let release: () => void = () => {};
  h.setSource(() => new Promise<any[]>((resolve) => { release = () => resolve([{ season: 1, episode: 3 }]); }));
  const pending = h.request("owner-C");
  await new Promise((resolve) => setImmediate(resolve));
  h.bumpGeneration();
  release();
  await assert.rejects(pending, /abort/i);
});
