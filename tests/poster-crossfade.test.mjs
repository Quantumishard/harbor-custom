import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as imgSize from "../src/lib/img-size.ts";

test("already loaded poster stays revealed without scheduling a redundant crossfade", async () => {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost/" });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let loaded = true;
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    complete: { get: () => loaded, configurable: true },
    naturalWidth: { get: () => (loaded ? 200 : 0), configurable: true },
  });
  const settings = { posterEffect: "fade", posterQuality: "max" };
  const probes = [];
  const observerRoots = [];
  const ScrollRootContext = React.createContext(null);
  const detailRef = { current: document.querySelector("#app") };
  const mocks = {
    react: React,
    "./row": { ScrollRootContext, resolveRowScrollRoot: (ref) => ref?.current },
    "react/jsx-runtime": jsx,
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/img-size": imgSize,
    "@/lib/visibility": {
      observeWithin: (_el, _margin, _callback, root) => {
        observerRoots.push(root);
        return () => {};
      },
      observeResize: () => () => {},
    },
    "@/lib/render-cause": { noteProbe: (label) => probes.push(label), recordRenderCause: () => {} },
    "@/lib/remote-image-proxy": { useProxiedImageSrc: (url) => url },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/components/poster.tsx", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => mocks[name] ?? {}, exports);
  const root = createRoot(document.querySelector("#app"));
  const render = (props) =>
    root.render(
      React.createElement(
        ScrollRootContext.Provider,
        { value: detailRef },
        React.createElement(exports.Poster, props),
      ),
    );
  try {
    await React.act(() => render({ src: "cached.jpg", seed: "title" }));
    assert.ok(document.querySelector("[data-loaded]"));
    assert.deepEqual(observerRoots, [detailRef.current]);
    assert.equal(document.querySelectorAll("img").length, 1);
    assert.equal(probes.filter((label) => label === "poster:committed-render").length, 1);
    loaded = false;
    await React.act(() => render({ src: "slow.jpg", seed: "title", fallbacks: ["fallback.jpg"] }));
    assert.equal(
      document.querySelectorAll("img").length,
      2,
      "old art remains while replacement loads",
    );
    assert.equal(document.querySelector("[data-loaded]"), null);
    await React.act(() =>
      document.querySelector(".harbor-poster-img").dispatchEvent(new dom.window.Event("error")),
    );
    assert.equal(document.querySelector(".harbor-poster-img").getAttribute("src"), "fallback.jpg");
    loaded = true;
    await React.act(() =>
      document.querySelector(".harbor-poster-img").dispatchEvent(new dom.window.Event("load")),
    );
    assert.ok(document.querySelector("[data-loaded]"));
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(
      document.querySelectorAll("img").length,
      1,
      "crossfade base is released after reveal",
    );
    await React.act(() => render({ src: "replacement.jpg", seed: "title" }));
    assert.ok(document.querySelector("[data-loaded]"));
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(document.querySelectorAll("img").length, 1);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
