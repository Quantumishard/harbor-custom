import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";

const t = (key) => key;
const icon = () => null;
const common = {
  react: React,
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "lucide-react": { Check: icon, ChevronDown: icon, Plus: icon, Trash2: icon, Lock: icon },
  "@/components/anchored-menu": { AnchoredMenu: () => null },
  "@/components/hover-tooltip": { HoverTooltip: ({ children }) => children },
  "@/lib/i18n": { useT: () => t },
  "@/lib/tracker-status-events": {
    useTrackerStatusVersion: () => 0,
    notifyTrackerStatusChanged: () => {},
  },
};

function sourceComponent(filename, exportName, mocks) {
  const content = readFileSync(filename, "utf8");
  const js = ts.transpileModule(content, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  const require = (id) => {
    if (id.endsWith(".png") || id.endsWith(".svg")) return { default: "test-image" };
    if (id in mocks) return mocks[id];
    if (id in common) return common[id];
    throw new Error(`Unexpected module ${id} (${filename})`);
  };
  new Function("require", "exports", js)(require, exports);
  return exports[exportName];
}

const status = new Map([
  ["kitsu:1", { ani: "COMPLETED", mal: "completed", simkl: "completed" }],
  ["kitsu:6", { ani: "CURRENT", mal: "watching", simkl: "watching" }],
]);

const cases = [
  {
    name: "AniList",
    component: sourceComponent("src/views/detail/add-to-anilist-button.tsx", "AddToAnilistButton", {
      "@/lib/anilist/provider": { useAnilist: () => ({ isConnected: true }) },
      "@/lib/anilist/sync": { resolveAnilistMediaId: async (id) => Number(id.split(":")[1]) },
      "@/lib/anilist/mutations": {
        fetchListEntry: async (id) => ({ entry: { id, status: status.get(`kitsu:${id}`).ani } }),
      },
    }),
  },
  {
    name: "MAL",
    component: sourceComponent("src/components/mal/add-to-mal-button.tsx", "AddToMalButton", {
      "@/lib/mal/provider": { useMal: () => ({ isConnected: true }) },
      "@/lib/mal/mutations": {
        resolveMalMediaId: async (id) => Number(id.split(":")[1]),
        fetchListEntry: async (id) => ({ entry: { status: status.get(`kitsu:${id}`).mal } }),
      },
    }),
  },
  {
    name: "Simkl",
    component: sourceComponent("src/views/detail/add-to-simkl-button.tsx", "AddToSimklButton", {
      "@/lib/simkl/client": { SimklApiError: class extends Error {} },
      "@/lib/simkl/ids": { resolveSimklTarget: async () => ({ kind: "anime", ids: { mal: null } }) },
      "@/lib/simkl/provider": { useSimkl: () => ({ isConnected: true }) },
      "@/lib/settings": { useSettings: () => ({ settings: { simklEnableUserRatings: false } }) },
      "@/lib/simkl/list-status": {
        loadSimklStatusMap: async () => new Map([...status].map(([id, s]) => [id, s.simkl])),
        statusForId: (map, id) => map.get(id) ?? null,
        MOVIE_STATUS_ORDER: ["completed", "watching"],
        SHOW_STATUS_ORDER: ["completed", "watching"],
        SIMKL_STATUS_LABELS: { completed: "Completed", watching: "Watching" },
      },
      "./simkl-rating-picker": { SimklRatingPicker: () => null },
    }),
    type: "series",
  },
];

test("switching anime seasons rebinds one button per tracker without reconciliation collisions", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
    url: "http://localhost/",
  });
  const old = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const element = dom.window.document.getElementById("app");
    const root = createRoot(element);
    for (const season of [1, 6, 1, 6]) {
      await act(async () => {
        root.render(
          React.createElement("div", null,
            cases.map(({ name, component, type }) =>
              React.createElement(component, { key: `${name.toLowerCase()}:kitsu:${season}`, harborId: `kitsu:${season}`, title: "JoJo", type }),
            ),
          ),
        );
      });
      const buttons = [...element.querySelectorAll("button")];
      assert.equal(buttons.length, cases.length, `season ${season} rendered exactly one button per tracker`);
      const expected = season === 1 ? "Completed" : "Watching";
      for (const [i, item] of cases.entries()) {
        assert.equal(buttons[i].textContent.trim(), expected, `${item.name} on season ${season}`);
      }
    }
    await act(async () => root.unmount());
  } finally {
    dom.window.close();
    Object.assign(globalThis, old);
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
