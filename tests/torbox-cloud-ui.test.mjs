import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  const cloud = {};
  const cloudCode = ts.transpileModule(
    readFileSync(new URL("../src/lib/debrid/torbox-cloud.ts", import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  new Function("require", "exports", cloudCode)(() => ({}), cloud);
  const slots = [],
    effects = [],
    lists = [],
    links = [],
    players = [];
  const settings = { tbKey: "fixture-A" };
  let slot = 0,
    tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const jsx = (type, props) => ({ type, props });
  const pending = (array, signal) => new Promise((resolve) => array.push({ resolve, signal }));
  const dependencies = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useState: (value) => {
        const i = slot++;
        if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
        return [
          slots[i],
          (next) => {
            slots[i] = typeof next === "function" ? next(slots[i]) : next;
          },
        ];
      },
      useRef: (value) => {
        const i = slot++;
        return (slots[i] ??= { current: value });
      },
      useMemo: (fn) => fn(),
      useEffect: (run, deps) => {
        const i = slot++;
        if (!same(slots[i]?.deps, deps))
          effects.push(() => {
            slots[i]?.cleanup?.();
            slots[i] = { deps, cleanup: run() };
          });
      },
    },
    "lucide-react": {},
    "@/assets/addon-logos/torbox.png": { default: "fixture" },
    "@/lib/media-file": { isPlayableVideoPath: (name) => name.endsWith(".mkv") },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/view": {
      useView: () => ({ openPlayer: (value) => players.push(value), openSettings() {} }),
    },
    "@/lib/debrid/torbox-cloud": {
      sortTorboxCloud: cloud.sortTorboxCloud,
      listTorboxCloud: (_key, signal) => pending(lists, signal),
      torboxCloudLink: (_key, _item, _file, signal) => pending(links, signal),
    },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/views/library/torbox-tab.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const api = {};
  new Function("require", "exports", code)((id) => {
    assert.ok(id in dependencies, id);
    return dependencies[id];
  }, api);
  const render = () => {
    slot = 0;
    tree = api.TorboxTab();
    effects.splice(0).forEach((fn) => fn());
  };
  const nodes = (type) => {
    const result = [],
      visit = (node) => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (node?.props) {
          if (node.type === type) result.push(node);
          visit(node.props.children);
        }
      };
    visit(tree);
    return result;
  };
  const buttons = () => nodes("button");
  render();
  return {
    settings,
    render,
    lists,
    links,
    players,
    buttons,
    nodes,
    unmount: () => {
      for (const item of slots) item?.cleanup?.();
    },
  };
}
const item = { kind: "torrents", id: 1, name: "Fixture", files: [{ id: 2, name: "fixture.mkv" }] };
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("date control changes the combined list from newest to oldest", async () => {
  const h = harness();
  h.lists[0].resolve([
    { ...item, name: "old torrent", createdAt: "2026-10-20T00:00:00Z" },
    { ...item, kind: "usenet", name: "new usenet", createdAt: "2026-10-22T00:00:00Z" },
    { ...item, kind: "webdl", name: "middle web", createdAt: "2026-10-21T00:00:00Z" },
  ]);
  await settle();
  h.render();
  const names = () =>
    h
      .nodes("span")
      .map((node) => node.props.children)
      .filter((value) => ["old torrent", "new usenet", "middle web"].includes(value));
  assert.deepEqual(names(), ["new usenet", "middle web", "old torrent"]);
  h.nodes("select")[0].props.onChange({ target: { value: "oldest" } });
  h.render();
  assert.deepEqual(names(), ["old torrent", "middle web", "new usenet"]);
});

test("TorBox playback uses a private cloud source and ignores late links after account changes", async () => {
  const h = harness();
  h.lists[0].resolve([item]);
  await settle();
  h.render();
  h.buttons().at(-1).props.onClick();
  h.links[0].resolve("https://example.invalid/fixture.mkv");
  await settle();
  h.render();
  assert.equal(h.players.length, 1);
  assert.equal(h.players[0].suppressCloudSync, true);
  assert.equal(h.players[0].meta.id, "torbox:torrents:1:2");
  h.buttons().at(-1).props.onClick();
  h.settings.tbKey = "fixture-B";
  h.render();
  assert.equal(h.links[1].signal.aborted, true);
  h.links[1].resolve("https://example.invalid/stale.mkv");
  await settle();
  h.render();
  assert.equal(h.players.length, 1);
});

test("TorBox unmount cancels listing and playback requests", async () => {
  const h = harness();
  h.lists[0].resolve([item]);
  await settle();
  h.render();
  h.buttons().at(-1).props.onClick();
  h.unmount();
  assert.equal(h.lists[0].signal.aborted, true);
  assert.equal(h.links[0].signal.aborted, true);
  h.links[0].resolve("https://example.invalid/stale.mkv");
  await settle();
  assert.equal(h.players.length, 0);
});
