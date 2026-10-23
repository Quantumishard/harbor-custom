import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness(respond) {
  const calls = [];
  const api = {};
  const source = readFileSync(new URL("../src/lib/aiostreams-library.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)((id) => {
    if (id === "@tauri-apps/api/core")
      return {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return respond(command, args);
        },
      };
    if (id === "@/lib/media-file")
      return { isPlayableVideoPath: (name) => /\.(mkv|mp4)$/i.test(name) };
    throw new Error(id);
  }, api);
  return { api, calls };
}
const connection = { sessionId: "fixture-session", baseUrl: "https://example.com/" };

test("browser login keeps opaque native session across navigation and disconnects it", async () => {
  const h = harness((command) =>
    command === "aiostreams_browser_begin"
      ? "login-window"
      : command === "aiostreams_browser_finish"
        ? connection
        : undefined,
  );
  assert.equal(await h.api.beginAioBrowserLogin(" https://example.com/ "), "login-window");
  assert.deepEqual(h.calls[0].args, { baseUrlInput: "https://example.com/" });
  await h.api.finishAioBrowserLogin("login-window");
  assert.equal(h.api.currentAioConnection(), connection);
  await h.api.disconnectAio();
  assert.equal(h.api.currentAioConnection(), null);
  assert.deepEqual(h.calls.at(-1), {
    command: "aiostreams_disconnect",
    args: { sessionId: "fixture-session" },
  });
});

test("file selection preserves archive paths and index zero, excluding unstreamable files", () => {
  const h = harness(() => {});
  const files = [
    { name: "episode.mkv", path: "archive/episode.mkv", index: 0, size: 100 },
    { name: "video.mp4", index: 0, size: 100 },
    { name: "unavailable.mkv", index: 1, streamable: false, size: 100 },
    { name: "notes.txt", index: 2, size: 10 },
  ];
  assert.deepEqual(h.api.playableAioFiles(files), files.slice(0, 2));
  assert.equal(h.api.aioFileSelector(files[0]), "archive/episode.mkv");
  assert.equal(h.api.aioFileSelector(files[1]), "0");
});

test("listing passes server pagination, search, status and date ordering", async () => {
  const page = { entries: [], total: 101 };
  const h = harness(() => page);
  const filters = {
    offset: 50,
    query: "show & title",
    status: "degraded",
    sort: "added",
    direction: "asc",
  };
  assert.equal(await h.api.listAio(connection, filters), page);
  assert.deepEqual(h.calls[0].args.request, { action: "list", ...filters });
});

test("playback asks native layer for a fresh URL and accepts only its loopback relay", async () => {
  let url = "http://127.0.0.1:32123/aiostreams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const h = harness(() => ({ url, filename: "episode.mkv" }));
  const file = { index: 0, name: "episode.mkv", size: 100 };
  assert.equal((await h.api.playAio(connection, "a".repeat(40), file)).url, url);
  assert.equal(h.calls[0].args.request.selector, "0");
  for (const invalid of [
    "https://other.example/video.mkv",
    "http://localhost:32123/aiostreams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "http://127.0.0.1:32123/arbitrary",
  ]) {
    url = invalid;
    await assert.rejects(
      h.api.playAio(connection, "a".repeat(40), file),
      /unexpected playback URL/,
    );
  }
});

test("unsupported instance responses fail clearly", async () => {
  const h = harness(() => ({ entries: "not-an-array", files: null }));
  await assert.rejects(h.api.listAio(connection, {}), /unsupported library response/);
  await assert.rejects(h.api.aioFiles(connection, "a".repeat(40)), /unsupported file list/);
});

test("remembered session restores once and is forgotten on explicit disconnect", async () => {
  const saved = { sessionId: "restored", baseUrl: "https://example.com/" };
  const h = harness((command) => (command === "aiostreams_restore" ? saved : undefined));
  const first = h.api.restoreAioConnection();
  assert.equal(h.api.restoreAioConnection(), first);
  assert.equal(await first, saved);
  assert.equal(saved.remembered, true);
  assert.equal(h.calls.filter((call) => call.command === "aiostreams_restore").length, 1);
  await h.api.disconnectAio();
  assert.ok(h.calls.some((call) => call.command === "aiostreams_forget"));
  assert.equal(h.api.currentAioConnection(), null);
});

test("remember preference is forwarded without storing a password in the connection", async () => {
  const h = harness((command) =>
    command === "aiostreams_browser_finish"
      ? { sessionId: "remembered", baseUrl: "https://example.com/" }
      : undefined,
  );
  const next = await h.api.finishAioBrowserLogin("login-window", true);
  assert.equal(next.remembered, true);
  assert.ok(
    h.calls.some((call) => call.command === "aiostreams_remember" && call.args.remember === true),
  );
  assert.equal("password" in next, false);
  assert.equal("cookie" in next, false);
});

test("storage failure keeps the live connection and reports that remembering failed", async () => {
  const h = harness((command) => {
    if (command === "aiostreams_browser_finish")
      return { sessionId: "live", baseUrl: "https://example.com/" };
    if (command === "aiostreams_remember") throw new Error("fixture failure");
  });
  const next = await h.api.finishAioBrowserLogin("login-window", true);
  assert.equal(h.api.currentAioConnection(), next);
  assert.match(next.warning, /could not update the saved sign-in/);
  assert.equal(next.remembered, undefined);
});
