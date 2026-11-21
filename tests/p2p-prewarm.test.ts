// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

// The prewarm helper reads the same browser globals as the engine callers.
(globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};

const prewarm = await import("../src/lib/streams/p2p-prewarm.ts");

type Added = { info_hash: string; stream_base: string; already_managed: boolean; files: [] };
type Fake = {
  calls: Array<{ magnet: string; trackers: string[]; fileIdx?: number }>;
  abandoned: string[];
  settle?: (added: Added) => void;
  add: (magnet: string, trackers: string[], fileIdx?: number) => Promise<Added>;
};

const HASH = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HASH = "89abcdef0123456789abcdef0123456789abcdef";

function hashOf(magnet: string): string {
  return magnet.match(/urn:btih:([a-f0-9]{40})/)?.[1] ?? HASH;
}

function target(infoHash = HASH, overrides: Record<string, unknown> = {}) {
  return { infoHash, sources: [], fileIdx: 2, ...overrides } as never;
}

function fakeDeps(options: { manual?: boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  const abandoned: string[] = [];
  const fake: Fake = {
    calls,
    abandoned,
    add: (magnet, trackers, fileIdx) => {
      calls.push({ magnet, trackers, fileIdx });
      const added: Added = {
        info_hash: hashOf(magnet),
        stream_base: "http://127.0.0.1:1/stream",
        already_managed: false,
        files: [],
      };
      if (!options.manual) return Promise.resolve(added);
      return new Promise<Added>((resolve) => {
        fake.settle = resolve;
      });
    },
  };
  return fake;
}

function install(fake: Fake) {
  prewarm.__resetPrewarmForTest();
  prewarm.__setPrewarmDepsForTest({
    add: fake.add,
    abandon: (hash) => fake.abandoned.push(hash),
  });
  return fake;
}

test("prewarms a source once and shares the in-flight add", async () => {
  const fake = install(fakeDeps({ manual: true }));
  const first = prewarm.prewarmP2pStream(target());
  const second = prewarm.prewarmP2pStream(target());
  assert.equal(first, second, "the second call must reuse the pending add");
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.magnet, /^magnet:\?xt=urn:btih:/);
  assert.equal(fake.calls[0]!.fileIdx, 2);
  fake.settle!({
    info_hash: HASH,
    stream_base: "http://127.0.0.1:1/stream",
    already_managed: false,
    files: [],
  });
  await first;
  assert.equal(fake.calls.length, 1);
});

test("a successful prewarm is abandoned on request", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target());
  prewarm.abandonPrewarmedStream(target());
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("abandoning while the add is in flight waits for it to exist", async () => {
  const fake = install(fakeDeps({ manual: true }));
  const pending = prewarm.prewarmP2pStream(target());
  prewarm.abandonPrewarmedStream(target());
  assert.deepEqual(fake.abandoned, [], "nothing to abandon before the add resolves");
  fake.settle!({
    info_hash: HASH,
    stream_base: "http://127.0.0.1:1/stream",
    already_managed: false,
    files: [],
  });
  await pending;
  await Promise.resolve();
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("recent prewarms are not repeated for the same infohash", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target());
  assert.equal(prewarm.prewarmP2pStream(target()), null);
  assert.equal(fake.calls.length, 1);
});

test("abandoning clears the cooldown so the next play can prewarm again", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target());
  prewarm.abandonPrewarmedStream(target());
  const again = prewarm.prewarmP2pStream(target());
  assert.ok(again, "a fresh prewarm may start after an abandon");
  await again;
  assert.equal(fake.calls.length, 2);
});

test("non-P2P sources are ignored", () => {
  const fake = install(fakeDeps());
  assert.equal(prewarm.prewarmP2pStream(target(HASH, { url: "https://example.test/a.mkv" })), null);
  assert.equal(prewarm.prewarmP2pStream(target(HASH, { infoHash: null })), null);
  assert.equal(fake.calls.length, 0);
});

test("the abandon timer removes a prewarm nobody played", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target(), { abandonAfterMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("a new hovered source discards the previous hover prewarm", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target(HASH), { intent: true });
  await prewarm.prewarmP2pStream(target(OTHER_HASH), { intent: true });
  assert.deepEqual(fake.abandoned, [HASH], "browsing rows must not keep every source warm");
  assert.equal(fake.calls.length, 2);
});

test("releasing the picker drops the active hover prewarm", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target(), { intent: true });
  prewarm.releaseIntentPrewarm();
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("the play path prewarming another source keeps the hover prewarm", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target(HASH), { intent: true });
  await prewarm.prewarmP2pStream(target(OTHER_HASH));
  assert.deepEqual(fake.abandoned, []);
  prewarm.releaseIntentPrewarm();
  assert.deepEqual(fake.abandoned, [HASH]);
});
