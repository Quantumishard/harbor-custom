import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { executeContextAction } from "../src/lib/context-actions.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/views/home/cw-section.tsx", import.meta.url), "utf8");
const rowSource = readFileSync(new URL("../src/components/row.tsx", import.meta.url), "utf8");

test("CW heading opens its shared context menu, copies on demand, and leaves no visible Copy CW button", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const old = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const opens: Array<{ target: any; at?: { x: number; y: number } }> = [];
  const row = (p: any) => h("section", { "data-test-row": "" },
    h("h3", null, p.title), h("div", { "data-header-right": "" }, p.headerRight), p.children);
  const mocks: Record<string, any> = {
    react: require("react"), "react/jsx-runtime": require("react/jsx-runtime"),
    "lucide-react": { ClipboardCopy: () => null, LogIn: () => null },
    "@/assets/stremio-wordmark.png": "stremio", "@/assets/nuvio.png": "nuvio",
    "@/components/auth-modal": { AuthModal: () => null },
    "@/components/nuvio-auth-modal": { NuvioAuthModal: () => null },
    "@/lib/nuvio/nuvio-auth": { activateNuvioAccountProvider: () => {} },
    "@/components/continue-card": { ContinueCard: () => h("div", null, "card") },
    "@/components/row": { Row: row },
    "@/lib/i18n": { useT: () => (value: string) => value },
    "@/lib/stremio": {}, "@/lib/trakt/library-key": { isLibraryItemWatched: () => false },
    "@/components/queue-basket/queue-continue-card": { QueueContinueCard: () => null },
    "@/lib/queue": { useQueueResumeItem: () => null },
    "@/lib/identity/use-card-grouping": { useIdentityCardGrouping: (items: any[]) => items },
    "@/lib/settings": { useSettings: () => ({ settings: {
      animeIdentityEnabled: false, animeIdentityRepairEnabled: false,
    } }) },
    "@/lib/context-menu": { useContextMenuActions: () => ({
      open: (event: any, target: any) => { event.preventDefault(); opens.push({ target }); },
      openAt: (at: any, target: any) => opens.push({ at, target }),
    }) },
    "@/lib/identity/shadow-observer": { observeIdentityShadow: () => {} },
  };
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `Unexpected module: ${name}`);
    return mocks[name];
  }, exports);
  const root = createRoot(document.getElementById("root")!);
  let copies = 0;
  const onCopyCw = async () => { copies++; return true; };
  const render = async (items: any[], loading = false, copy = onCopyCw) =>
    act(async () => root.render(h(exports.CWSection, {
      signedIn: true, items, onDismiss: () => {}, onCopyCw: copy, loading,
    })));
  const contextMenu = async (node: Element) => {
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(() => node.dispatchEvent(event));
    assert.ok(event.defaultPrevented, "heading must intercept the native menu");
    return opens.at(-1)!.target;
  };
  try {
    await render([{ _id: "tt1234567", type: "series" }]);
    assert.match(rowSource, /\{title\}/, "Row must render supplied heading content");
    assert.equal(document.querySelectorAll("[data-cw-copy]").length, 0);
    assert.equal(document.querySelectorAll("[data-cw-heading]").length, 1);
    assert.equal(document.querySelector("[data-header-right]")?.children.length, 0);
    const heading = document.querySelector("[data-cw-heading]")!;
    const target = await contextMenu(heading);
    assert.equal(target.kind, "actions");
    assert.equal(target.actions()[0].label, "Copy CW");
    assert.equal(target.actions()[0].disabled, false);
    await act(() => executeContextAction(target, "home:continue-watching:copy-snapshot"));
    assert.equal(copies, 1, "copy only runs after selecting the context action");

    await act(() => heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "ContextMenu",
    })));
    assert.ok(opens.at(-1)!.at, "keyboard context-menu key must open at the heading");
    await act(() => heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "F10", shiftKey: true,
    })));
    assert.ok(opens.at(-1)!.at, "Shift+F10 must open at the heading");

    await render([], false);
    assert.ok(document.querySelector("[data-cw-heading]"), "empty-state heading remains actionable");
    await contextMenu(document.querySelector("[data-cw-heading]")!);
    await render([], true);
    assert.ok(document.querySelector("[data-cw-heading]"), "loading heading remains reachable");
    const loadingMenu = await contextMenu(document.querySelector("[data-cw-heading]")!);
    assert.equal(loadingMenu.actions()[0].disabled, true, "do not copy a loading-only snapshot");
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    Object.assign(globalThis, old);
  }
});
