import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness(fetcher) {
  const source = readFileSync(
    new URL("../src/lib/debrid/torbox-cloud.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {},
    calls = [];
  new Function("require", "exports", code)((id) => {
    assert.equal(id, "@/lib/safe-fetch");
    return {
      safeFetch: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return fetcher(new URL(url), options);
      },
    };
  }, api);
  return { api, calls };
}
const response = (data) => ({ ok: true, json: async () => ({ success: true, data }) });
const signal = () => new AbortController().signal;

test("date ordering interleaves all download types by creation instant, keeping unknown dates last", async () => {
  const dates = {
    torrents: "2026-10-20T10:00:00Z",
    usenet: "2026-10-22T09:00:00+02:00",
    webdl: "2026-10-21T10:00:00Z",
  };
  const h = harness(async (url) =>
    response([
      { id: 1, download_finished: true, created_at: dates[url.pathname.split("/").at(-2)] },
    ]),
  );
  const items = await h.api.listTorboxCloud("fixture", signal());
  assert.ok(items.every((item) => item.createdAt));
  const original = [...items];
  const unknown = [
    { kind: "webdl", id: 2 },
    { kind: "usenet", id: 3, createdAt: "invalid" },
  ];
  assert.deepEqual(
    h.api.sortTorboxCloud([...items, ...unknown], "newest").map((x) => x.kind),
    ["usenet", "webdl", "torrents", "webdl", "usenet"],
  );
  assert.deepEqual(
    h.api.sortTorboxCloud([...items, ...unknown], "oldest").map((x) => x.kind),
    ["torrents", "webdl", "usenet", "webdl", "usenet"],
  );
  assert.deepEqual(items, original);
  const ties = items.map((item) => ({ ...item, createdAt: "2026-10-21T00:00:00Z" }));
  assert.deepEqual(h.api.sortTorboxCloud(ties, "newest"), ties);
});

test("cloud listing covers torrent, usenet and web downloads and excludes incomplete entries", async () => {
  const h = harness(async (url) =>
    response([
      {
        id: 1,
        name: url.pathname,
        download_finished: true,
        files: [{ id: 4, name: "movie.mkv", size: 10 }],
      },
      { id: 2, download_present: true },
      { id: 3, download_finished: false },
    ]),
  );
  const s = signal(),
    items = await h.api.listTorboxCloud("fixture-only", s);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["torrents", "torrents", "usenet", "usenet", "webdl", "webdl"],
  );
  assert.equal(
    items.every((item) => item.id !== 3),
    true,
  );
  assert.equal(items[0].files[0].name, "movie.mkv");
  for (const call of h.calls) {
    assert.equal(call.options.headers.Authorization, "Bearer fixture-only");
    assert.equal(call.options.signal, s);
    assert.equal(call.url.searchParams.get("limit"), "1000");
  }
});

test("cloud listing paginates full responses and tolerates unavailable categories", async () => {
  const h = harness(async (url) => {
    if (!url.pathname.includes("torrents")) throw Error("category unavailable");
    if (url.searchParams.get("offset") === "0")
      return response(Array.from({ length: 1000 }, (_, id) => ({ id, download_finished: true })));
    return response([{ id: 1000, download_present: true }]);
  });
  const items = await h.api.listTorboxCloud("fixture-only", signal());
  assert.equal(items.length, 1001);
  assert.ok(h.calls.some((call) => call.url.searchParams.get("offset") === "1000"));
});

test("cloud listing reports total failure and propagates cancellation", async () => {
  const h = harness(async () => ({ ok: false, status: 401 }));
  await assert.rejects(h.api.listTorboxCloud("fixture-only", signal()), /Invalid TorBox API key/);
  const controller = new AbortController();
  controller.abort();
  const aborted = harness(async (_url, options) => {
    options.signal.throwIfAborted();
  });
  await assert.rejects(aborted.api.listTorboxCloud("fixture-only", controller.signal), {
    name: "AbortError",
  });
});

for (const [kind, param] of [
  ["torrents", "torrent_id"],
  ["usenet", "usenet_id"],
  ["webdl", "web_id"],
]) {
  test(`${kind} playback uses its own identifier and encodes the token`, async () => {
    const h = harness(async () => response("https://example.invalid/video.mkv"));
    const s = signal();
    assert.equal(
      await h.api.torboxCloudLink("fixture&+=only", { kind, id: 12 }, { id: 34 }, s),
      "https://example.invalid/video.mkv",
    );
    const call = h.calls[0];
    assert.equal(call.url.searchParams.get(param), "12");
    assert.equal(call.url.searchParams.get("file_id"), "34");
    assert.equal(call.url.searchParams.get("token"), "fixture&+=only");
    assert.equal(call.options.signal, s);
  });
}

test("playback rejects non-HTTP download links", async () => {
  for (const link of [null, "javascript:fixture", "file:///fixture", ""]) {
    const h = harness(async () => response(link));
    await assert.rejects(
      h.api.torboxCloudLink("fixture-only", { kind: "torrents", id: 1 }, { id: 2 }, signal()),
      /playable link/,
    );
  }
});
