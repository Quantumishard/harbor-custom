// Per-dependency startup watchdogs must stay terminal for late results.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bootDependencyReport,
  markBootFallback,
  resetBootDependencies,
  withBootWatchdog,
} from "../src/lib/boot-dependencies.ts";

test("a dependency that settles in time is recorded as ok", async () => {
  resetBootDependencies();
  const result = await withBootWatchdog("features", Promise.resolve("ready"), 50);
  assert.deepEqual(result, { value: "ready", timedOut: false, failed: false });
  assert.equal(bootDependencyReport().features, "ok");
});

test("a timeout resolves the boot decision and ignores a late success", async () => {
  resetBootDependencies();
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const result = await withBootWatchdog("themes", pending, 10);
  assert.equal(result.timedOut, true);
  assert.equal(result.failed, false);
  assert.equal(bootDependencyReport().themes, "timed-out");

  release("late");
  await Promise.resolve();
  assert.equal(bootDependencyReport().themes, "timed-out");
});

test("a timeout ignores a late rejection without an unhandled rejection", async () => {
  resetBootDependencies();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const result = await withBootWatchdog("locale", pending, 10);
  assert.equal(result.timedOut, true);
  assert.equal(bootDependencyReport().locale, "timed-out");

  reject(new Error("late failure"));
  await Promise.resolve();
  assert.equal(bootDependencyReport().locale, "timed-out");
});

test("a rejected dependency is recorded as failed", async () => {
  resetBootDependencies();
  const result = await withBootWatchdog("music", Promise.reject(new Error("boom")), 50);
  assert.equal(result.failed, true);
  assert.equal(result.timedOut, false);
  assert.equal(bootDependencyReport().music, "failed");
});

test("continuing with a fallback replaces the timed-out state", async () => {
  resetBootDependencies();
  const result = await withBootWatchdog("features", new Promise<void>(() => {}), 10);
  assert.equal(result.timedOut, true);
  markBootFallback("features");
  assert.equal(bootDependencyReport().features, "fallback");
});
