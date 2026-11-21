import assert from "node:assert/strict";
import test from "node:test";
import { createChapterImageCache } from "../src/views/manga/manga-reader/chapter-image-cache-core.ts";

const image = (size) => new Blob([new Uint8Array(size)], { type: "image/jpeg" });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("Flipbook and Long Strip share compressed image bytes and a single in-flight request", async () => {
  const deferredLoad = deferred();
  const calls = [];
  const cache = createChapterImageCache((url, headers) => {
    calls.push({ url, headers });
    return deferredLoad.promise;
  });
  const url = "https://img.batcave.biz/img/1.jpg?signature=token";
  const first = cache.fetch(url, { Referer: "https://batcave.biz/" });
  const second = cache.fetch(url, { referer: "https://batcave.biz/" });
  assert.equal(first, second, "case-normalized headers coalesce across modes");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  deferredLoad.resolve(image(150));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(cache.peek(url, { Referer: "https://batcave.biz/" }), a);
  assert.equal(await cache.fetch(url, { Referer: "https://batcave.biz/" }), a);
  assert.equal(calls.length, 1);
});

test("different header values never share a cached image", async () => {
  let calls = 0;
  const cache = createChapterImageCache(async () => { calls++; return image(50); });
  const url = "https://cdn.test/image.jpg";
  await cache.fetch(url, { Referer: "https://source-one.test/" });
  await cache.fetch(url, { Referer: "https://source-two.test/" });
  assert.equal(calls, 2);
  assert.equal(cache.peek(url, { Referer: "https://source-one.test/" })?.size, 50);
});

test("cache evicts least-recently-used bytes and keeps current page hot", async () => {
  let calls = 0;
  const cache = createChapterImageCache(async () => { calls++; return image(4); }, {
    maxBytes: 8, maxEntries: 4,
  });
  await cache.fetch("page-1", {});
  await cache.fetch("page-2", {});
  cache.peek("page-1", {});
  await cache.fetch("page-3", {});
  assert.equal(cache.peek("page-2", {}), undefined);
  assert.equal(cache.peek("page-1", {})?.size, 4);
  assert.equal(cache.peek("page-3", {})?.size, 4);
  assert.equal(calls, 3);
});

test("visible requests overtake queued prefetch while concurrency stays bounded", async () => {
  const started = [];
  const gates = new Map();
  const cache = createChapterImageCache(async (url) => {
    started.push(url);
    const gate = deferred();
    gates.set(url, gate);
    return gate.promise;
  }, { maxConcurrent: 1 });
  const a = cache.fetch("a", {}, { priority: "near" });
  const b = cache.fetch("b", {}, { priority: "near" });
  const c = cache.fetch("c", {}, { priority: "visible" });
  await Promise.resolve();
  assert.deepEqual(started, ["a"]);
  gates.get("a").resolve(image(1));
  await a;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "c"]);
  gates.get("c").resolve(image(1));
  await c;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "c", "b"]);
  gates.get("b").resolve(image(1));
  await b;
});

test("rejected requests are retryable and manual refresh bypasses a cached success", async () => {
  let calls = 0;
  const cache = createChapterImageCache(async () => {
    calls++;
    if (calls === 1) throw Error("HTTP 403");
    return image(calls);
  });
  await assert.rejects(cache.fetch("page", {}), /HTTP 403/);
  await cache.fetch("page", {});
  assert.equal(calls, 2);
  await cache.fetch("page", {});
  assert.equal(calls, 2);
  await cache.fetch("page", {}, { refresh: true });
  assert.equal(calls, 3);
});
