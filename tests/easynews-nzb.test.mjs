import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", ...Object.keys(globals), code)(
    (id) => {
      assert.ok(id in dependencies, id);
      return dependencies[id];
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}
const http = `https://fixture:password@members.easynews.com/dl/auto/auto/${"a".repeat(40)}.mkv/Concert.mkv`;

test("native choices preserve HTTP, primary ranking and signature without duplicate NZB rows", () => {
  const api = load(
    "src/lib/streams/easynews-nzb-options.ts",
    {},
    { window: { __TAURI_INTERNALS__: {} } },
  );
  const source = { url: http, addonName: "Easynews", behaviorHints: { easynewsSig: "fixture" } };
  const picker = { primary: source, byTier: { SD: source }, all: [source] };
  const result = api.withEasynewsNzbOptions(picker);
  assert.equal(result.primary, source);
  assert.equal(result.all[0], source);
  assert.equal(result.all.length, 2);
  assert.ok(api.isEasynewsNzbOption(result.all[1]));
  assert.equal(result.all[1].behaviorHints.easynewsSig, "fixture");
  assert.match(result.all[1].addonName, /NZB via AIOStreams/);
  assert.equal(api.withEasynewsNzbOptions(result).all.length, 2);
  for (const invalid of [
    http.replace("members.easynews.com", "easynews.com.evil.example"),
    "https://worker.example/play/private",
    "file:///video.mkv",
  ])
    assert.equal(api.isEasynewsHttpUrl(invalid), false);
});

test("web clients keep their original choices", () => {
  const api = load("src/lib/streams/easynews-nzb-options.ts", {}, { window: {} });
  const picker = { all: [{ url: http }] };
  assert.equal(api.withEasynewsNzbOptions(picker), picker);
});

const relay = "http://127.0.0.1:32123/aiostreams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function importer(respond, connection = { sessionId: "fixture" }) {
  const calls = [];
  const api = load(
    "src/lib/easynews-nzb.ts",
    {
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return respond(command, args);
        },
      },
      "./aiostreams-library": { restoreAioConnection: async () => connection },
    },
    { crypto: { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
  );
  return { api, calls };
}

test("imports use the native authenticated session and accept only the local relay", async () => {
  const h = importer(() => ({ url: relay, filename: "Concert.mkv" }));
  assert.equal(
    (await h.api.playEasynewsNzb(http, "signature", new AbortController().signal)).url,
    relay,
  );
  assert.equal(h.calls[0].command, "aiostreams_easynews_play");
  assert.equal(h.calls[0].args.sessionId, "fixture");
  assert.equal(h.calls[0].args.sig, "signature");
  const bad = importer(() => ({ url: "https://remote.example/private" }));
  await assert.rejects(
    bad.api.playEasynewsNzb(http, null, new AbortController().signal),
    /unexpected playback/,
  );
});

test("missing sign-in makes no import request", async () => {
  const h = importer(() => {
    throw new Error("must not import");
  }, null);
  await assert.rejects(
    h.api.playEasynewsNzb(http, null, new AbortController().signal),
    /Library → AIOStreams/,
  );
  assert.equal(h.calls.length, 0);
});

test("cancellation sends a native cancel request and never returns stale playback", async () => {
  let finish;
  const h = importer((command) =>
    command === "aiostreams_easynews_play"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  const controller = new AbortController();
  const playing = h.api.playEasynewsNzb(http, null, controller.signal);
  await Promise.resolve();
  controller.abort();
  finish({ url: relay });
  await assert.rejects(playing, /cancelled/);
  assert.equal(h.calls[1].command, "aiostreams_easynews_cancel");
});
