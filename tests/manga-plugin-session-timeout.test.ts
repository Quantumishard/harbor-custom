import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(
  path: string,
  imports: Record<string, unknown>,
  globals: Record<string, unknown> = {},
) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out: Record<string, any> = {};
  new Function("require", "exports", ...Object.keys(globals), js)(
    (name: string) => {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
    out,
    ...Object.values(globals),
  );
  return out;
}

test("foreground plugin calls outlive HTTP verification while background calls keep their deadlines", async () => {
  const workers: any[] = [];
  class WorkerStub {
    options: any;
    constructor(_plugin: unknown, options: unknown) {
      this.options = options;
      workers.push(this);
    }
    call() {
      return Promise.resolve([]);
    }
  }
  const runtime = loadModule("../src/lib/manga/plugins/runtime.ts", {
    "./worker-host": { PluginWorker: WorkerStub, INTERACTIVE_PLUGIN_TIMEOUT_MS: 125_000 },
    "./adapter": { toStrings: (value: unknown) => value },
  });
  const plugin = { id: "fixture", name: "Protected source" };
  const foreground = runtime.pluginProvider(plugin);
  const background = runtime.pluginProvider(plugin, true);
  assert.equal(workers[0].options.callTimeoutMs, 125_000);
  assert.equal(foreground.requestTimeoutMs, 130_000);
  assert.equal(workers[1].options.callTimeoutMs, undefined);
  assert.equal(background.requestTimeoutMs, undefined);
  assert.deepEqual(await foreground.pageUrls("chapter"), []);
});

test("worker uses the host deadline and clears its timer when the plugin responds", async () => {
  const workerInstances: any[] = [];
  const timers = new Map<number, number>();
  let sequence = 0;
  class WorkerStub {
    onmessage: any;
    constructor() {
      workerInstances.push(this);
    }
    postMessage(message: any) {
      if (message.type === "init") this.onmessage({ data: { type: "ready", meta: {} } });
    }
    terminate() {}
  }
  const workerModule = loadModule(
    "../src/lib/manga/plugins/worker-host.ts",
    {
      "./sandbox": { SANDBOX_SOURCE: "" },
      "./host-http": { TEXT_CHALLENGE_TIMEOUT: 120_000 },
      "./host-parse": {},
    },
    {
      Worker: WorkerStub,
      setTimeout: (_callback: unknown, delay: number) => {
        timers.set(++sequence, delay);
        return sequence;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  for (const [floor, expected] of [
    [125_000, 125_000],
    [0, 30_000],
  ]) {
    const worker = new workerModule.PluginWorker({ source: "" }, { callTimeoutMs: floor });
    const result = worker.call("pageUrls", ["chapter"], 30_000);
    await Promise.resolve();
    assert.deepEqual([...timers.values()], [expected]);
    workerInstances.at(-1).onmessage({ data: { type: "result", id: "c1", value: ["page"] } });
    assert.deepEqual(await result, ["page"]);
    assert.equal(timers.size, 0);
    worker.dispose();
  }
});

test("routed chapter requests retain the owning extension's verification deadline", async () => {
  const timers = new Map<number, number>();
  let sequence = 0;
  let complete: (pages: string[]) => void = () => {};
  const provider = {
    requestTimeoutMs: 130_000,
    pageUrls: () =>
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
  };
  const api = loadModule(
    "../src/lib/manga/api.ts",
    {
      "@/lib/storage-recovery": {},
      "./sources": {
        ensureMangaSources: async () => {},
        activeMangaSourceId: () => "another-source",
        activeMangaProvider: () => ({}),
      },
      "./sources/aggregate": { routeById: () => ({ provider, orig: "chapter" }) },
      "./sources/suwayomi/source-events": {},
      "./library-events": {},
      "./lang-filter": {},
      "./model": {},
    },
    {
      window: {
        setTimeout: (_callback: unknown, delay: number) => {
          timers.set(++sequence, delay);
          return sequence;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    },
  );
  const result = api.chapterPages("plugin::chapter");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...timers.values()], [130_000]);
  complete(["page"]);
  assert.deepEqual(await result, ["page"]);
  assert.equal(timers.size, 0);
});
