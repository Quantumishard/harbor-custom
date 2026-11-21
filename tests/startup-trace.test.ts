// Startup trace math is pure and must stay independent of browser timing APIs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeStartupMeasures,
  resetStartupTrace,
  startupFinish,
  startupMarkOnce,
  startupSnapshot,
  startupTraceHistory,
  startupEvent,
  type NativeStartupTimeline,
} from "../src/lib/startup-trace.ts";

test("startup measures keep native and webview origins separate", () => {
  const marks = new Map<string, number>([
    ["webview-entry", 10],
    ["mount.start", 20],
    ["boot.critical-done", 120],
    ["boot.render-called", 140],
    ["shell.committed", 200],
    ["app.ready", 400],
    ["first-input", 1200],
    ["home.data-ready", 1480],
    ["home.rows-committed", 1500],
    ["root.revealed", 1800],
    ["root.first-frame", 1810],
    ["navigation.focusable", 1900],
    ["navigation.interactive", 1950],
    ["splash.removed", 2080],
  ]);
  const native: NativeStartupTimeline = {
    processStartUnixMs: 1_000,
    windowShownUnixMs: 2_000,
    windowShownElapsedMs: 700,
  };
  const measures = computeStartupMeasures(marks, native, 1_500);
  const value = (name: string) => measures.find((measure) => measure.name === name)?.ms;

  assert.equal(value("webview.navigation→entry"), 10);
  assert.equal(value("webview.navigation→shell-committed"), 200);
  assert.equal(value("webview.navigation→first-input"), 1200);
  assert.equal(value("webview.navigation→home-data-ready"), 1480);
  assert.equal(value("mount.start→critical-done"), 100);
  assert.equal(value("root-revealed→first-frame"), 10);
  assert.equal(value("root-revealed→navigation-focusable"), 100);
  assert.equal(value("root-revealed→navigation-interactive"), 150);
  assert.equal(
    value("root-revealed→first-input"),
    undefined,
    "input before reveal must not produce a negative post-reveal latency",
  );
  assert.equal(
    value("root-revealed→home-rows-committed"),
    0,
    "content ready before reveal must not report negative time",
  );
  assert.equal(
    value("native.process-start→window-shown"),
    700,
    "monotonic native elapsed is preferred over wall-clock subtraction",
  );
  assert.equal(value("native.process-start→root-revealed"), 2_300);
  assert.equal(
    value("native.window-shown→shell-committed"),
    -300,
    "a window shown after the shell commits is meaningful, not a bug",
  );

  const afterReveal = new Map(marks);
  afterReveal.set("first-input", 1900);
  const afterMeasures = computeStartupMeasures(afterReveal, null, 1_500);
  assert.equal(
    afterMeasures.find((measure) => measure.name === "root-revealed→first-input")?.ms,
    100,
    "input after reveal reports the post-reveal latency",
  );
});

test("startup marks are first-wins", () => {
  resetStartupTrace();
  startupMarkOnce("test.once");
  startupMarkOnce("test.once");
  assert.equal(startupSnapshot().marks.filter((mark) => mark.name === "test.once").length, 1);
});

test("one WebView startup keeps one launch id", () => {
  resetStartupTrace();
  const first = startupSnapshot();
  const second = startupSnapshot();
  assert.ok(first.launchId);
  assert.equal(first.launchId, second.launchId);
});

test("structured startup events keep their detail and reset", () => {
  resetStartupTrace();
  startupEvent("test.event", { value: 7, ok: true });
  const event = startupSnapshot().events.find((entry) => entry.name === "test.event");
  assert.deepEqual(event?.detail, { value: 7, ok: true });
  resetStartupTrace();
  assert.equal(startupSnapshot().events.length, 0);
});

test("an enabled trace is persisted", async () => {
  const data = new Map<string, string>([["harbor.startupTrace", "1"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, String(value)),
      removeItem: (key: string) => data.delete(key),
    },
  });
  const table = console.table;
  const info = console.info;
  console.table = () => {};
  console.info = () => {};
  try {
    resetStartupTrace();
    startupMarkOnce("root.revealed");
    await startupFinish();
    assert.equal(startupTraceHistory().length, 1);
  } finally {
    console.table = table;
    console.info = info;
    resetStartupTrace();
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
