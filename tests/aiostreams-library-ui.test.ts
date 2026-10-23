import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness";

function harness(connected = true, saved: any = null) {
  const lists: any[] = [],
    files: any[] = [],
    streams: any[] = [],
    players: any[] = [],
    cancelled: string[] = [];
  let connection: any = connected
    ? { sessionId: "fixture", baseUrl: "https://example.com/" }
    : null;
  const deferred = (queue: any[], args: any) =>
    new Promise((resolve) => queue.push({ resolve, args }));
  const jsx = (type: any, props: any) => ({ type, props });
  const h = hookHarness(
    "src/views/library/aiostreams-tab.tsx",
    "AiostreamsTab",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "lucide-react": {},
      "@/lib/platform": { isWindowsDesktop: () => true },
      "@/assets/addon-logos/aiostreams.png": { default: "fixture" },
      "@/lib/view": { useView: () => ({ openPlayer: (value: any) => players.push(value) }) },
      "@/lib/aiostreams-library": {
        currentAioConnection: () => connection,
        restoreAioConnection: async () => {
          if (saved instanceof Error) throw saved;
          return saved;
        },
        aioDesktopAvailable: () => true,
        beginAioBrowserLogin: async () => "login-window",
        cancelAioBrowserLogin: async (id: string) => {
          cancelled.push(id);
        },
        finishAioBrowserLogin: async () =>
          (connection = { sessionId: "fixture", baseUrl: "https://example.com/" }),
        disconnectAio: async () => {
          connection = null;
        },
        listAio: (_connection: any, filters: any) => deferred(lists, filters),
        aioFiles: (_connection: any, hash: any) => deferred(files, hash),
        aioFileSelector: (file: any) => String(file.index),
        playAio: (_connection: any, hash: any, file: any) => deferred(streams, { hash, file }),
        connectAio: async () => connection,
      },
    },
    {
      localStorage: { getItem: () => "", setItem() {} },
      setTimeout: () => 0,
      clearTimeout() {},
    },
  );
  let tree: any;
  const render = () => {
    tree = h.render();
  };
  const nodes = (type: string) => {
    const result: any[] = [];
    const visit = (node: any) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node?.props) {
        if (node.type === type) result.push(node);
        visit(node.props.children);
      }
    };
    visit(tree);
    return result;
  };
  const text = (node: any): string =>
    Array.isArray(node)
      ? node.map(text).join("")
      : node?.props
        ? text(node.props.children)
        : typeof node === "string" || typeof node === "number"
          ? String(node)
          : "";
  const button = (label: string) => nodes("button").find((node) => text(node) === label);
  render();
  return { ...h, render, nodes, button, lists, files, streams, players, cancelled };
}

const entry = {
  nzbHash: "a".repeat(40),
  name: "Fixture release",
  status: "available",
  files: [],
  addedAt: "2026-10-23",
  size: 123,
};
const file = { name: "episode.mkv", index: 0, size: 123 };

test("browser sign-in opens a window and connects to the library after confirmation", async () => {
  const h = harness(false);
  await flushPromises();
  h.render();
  h.nodes("input")[0].props.onChange({ target: { value: "https://example.com/" } });
  h.render();
  h.button("Open sign-in window").props.onClick();
  await flushPromises();
  h.render();
  h.button("I’m signed in — connect library").props.onClick();
  await flushPromises();
  h.render();
  assert.equal(h.lists.length, 1);
  assert.equal(h.lists[0].args.direction, "desc");
  h.unmount();
});

test("abandoning sign-in closes its private browser window", async () => {
  const h = harness(false);
  await flushPromises();
  h.render();
  h.button("Open sign-in window").props.onClick();
  await flushPromises();
  h.render();
  h.unmount();
  assert.deepEqual(h.cancelled, ["login-window"]);
});

test("paging and status changes issue server queries and clear old rows", async () => {
  const h = harness();
  h.lists[0].resolve({ entries: [entry], total: 101 });
  await flushPromises();
  h.render();
  h.button("Next").props.onClick();
  h.render();
  h.render();
  assert.equal(h.lists[1].args.offset, 50);
  assert.equal(
    h
      .nodes("button")
      .filter((b) => b.props.children?.[1]?.props?.children?.[0]?.props?.children === entry.name)
      .length,
    0,
  );
  h.nodes("select")[0].props.onChange({ target: { value: "degraded" } });
  h.render();
  assert.equal(h.lists[2].args.offset, 0);
  assert.equal(h.lists[2].args.status, "degraded");
  h.unmount();
});

test("disconnect ignores an in-flight playback response", async () => {
  const h = harness();
  h.lists[0].resolve({ entries: [entry], total: 1 });
  await flushPromises();
  h.render();
  const row = h
    .nodes("button")
    .find((b) => b.props.children?.[1]?.props?.children?.[0]?.props?.children === entry.name);
  assert.ok(row);
  row.props.onClick();
  h.files[0].resolve([file]);
  await flushPromises();
  h.render();
  const play = h.nodes("button").find((b) => b.props.children?.[1]?.props?.children === file.name);
  assert.ok(play);
  play.props.onClick();
  h.button("Disconnect").props.onClick();
  h.streams[0].resolve({ url: "http://127.0.0.1:12345/aiostreams/fixture", filename: file.name });
  await flushPromises();
  h.render();
  assert.equal(h.players.length, 0);
  h.unmount();
});

test("selected library file opens Harbor playback with a stable private identity", async () => {
  const h = harness();
  h.lists[0].resolve({ entries: [entry], total: 1 });
  await flushPromises();
  h.render();
  h.nodes("button")
    .find((b) => b.props.children?.[1]?.props?.children?.[0]?.props?.children === entry.name)
    .props.onClick();
  h.files[0].resolve([file]);
  await flushPromises();
  h.render();
  h.nodes("button")
    .find((b) => b.props.children?.[1]?.props?.children === file.name)
    .props.onClick();
  const url = "http://127.0.0.1:12345/aiostreams/fixture";
  h.streams[0].resolve({ url, filename: file.name });
  await flushPromises();
  assert.equal(h.players[0].url, url);
  assert.equal(h.players[0].resume, true);
  assert.equal(h.players[0].suppressCloudSync, true);
  assert.equal(h.players[0].meta.id, `aiostreams:example.com:${entry.nzbHash}:0`);
  h.unmount();
});

test("saved sign-in reconnects the library without opening a login window", async () => {
  const h = harness(false, {
    sessionId: "saved",
    baseUrl: "https://example.com/",
    remembered: true,
  });
  assert.equal(h.lists.length, 0);
  await flushPromises();
  h.render();
  assert.equal(h.lists.length, 1);
  assert.equal(h.nodes("form").length, 0);
  h.unmount();
});

test("expired remembered sign-in returns to the login form with a clear error", async () => {
  const h = harness(false, new Error("Your saved sign-in expired"));
  await flushPromises();
  h.render();
  assert.equal(h.nodes("form").length, 1);
  assert.equal(
    h.nodes("p").find((node) => node.props.role === "alert").props.children,
    "Your saved sign-in expired",
  );
  h.unmount();
});
