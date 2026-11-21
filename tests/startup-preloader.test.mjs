import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("view warmup starts one import per idle turn, recovers from failure and cancels on unmount", async () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const hook = source.slice(
    source.indexOf("function useViewPreloader("),
    source.indexOf("const KEEP_ALIVE_MS"),
  );
  const imports = [...new Set(hook.match(/\bimport[A-Z]\w+/g))];
  const routes = [...new Set([...hook.matchAll(/(\w+)\.preload,/g)].map((match) => match[1]))];
  const names = [...routes, ...imports];
  const idle = new Map();
  const started = [];
  let handle = 0;
  let cleanup;
  const code = ts.transpileModule(hook, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("useRef", "useEffect", "window", ...names, `${code}\nuseViewPreloader("");`)(
    (value) => ({ current: value }),
    (effect) => {
      cleanup = effect();
    },
    {
      requestIdleCallback: (callback) => {
        idle.set(++handle, callback);
        return handle;
      },
      cancelIdleCallback: (id) => idle.delete(id),
    },
    ...names.map((name, i) => {
      const load = async () => {
        started.push(name);
        if (i === 0) throw new Error("fixture");
      };
      return routes.includes(name) ? { preload: load } : load;
    }),
  );
  const turn = async () => {
    const [id, callback] = idle.entries().next().value;
    idle.delete(id);
    callback();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  assert.equal(started.length, 0);
  await turn();
  assert.equal(started.length, 1);
  await turn();
  assert.deepEqual(
    started,
    ["DetailView", "PreloadedDiscover"],
    "failed warmup leaves the next primary route queued",
  );
  cleanup();
  assert.equal(idle.size, 0);
});

test("a preloaded route renders synchronously and preserves an in-flight import", async () => {
  const { preloadableView } = await import("../src/lib/lazy-view.ts");
  const React = await import("react");
  const { renderToString } = await import("react-dom/server");
  let imports = 0;
  let finish;
  const Route = preloadableView(() => {
    imports++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const warm = Route.preload();
  assert.equal(Route.preload(), warm);
  finish(({ title }) => React.createElement("h1", null, title));
  await warm;
  assert.equal(
    renderToString(React.createElement(Route, { title: "Discover" })),
    "<h1>Discover</h1>",
  );
  assert.equal(imports, 1);
});

test("a failed idle import can be retried on a later preload", async () => {
  const { preloadableView } = await import("../src/lib/lazy-view.ts");
  let imports = 0;
  const View = () => null;
  const Route = preloadableView(async () => {
    if (++imports === 1) throw new Error("fixture");
    return View;
  });
  await assert.rejects(Route.preload(), /fixture/);
  assert.equal(await Route.preload(), View);
  assert.equal(imports, 2);
});
