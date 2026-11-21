import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function fixture() {
  let at = 0;
  let tick: (() => void) | undefined;
  let cleared = false;
  const logs: string[] = [],
    native: string[] = [];
  const module = { exports: {} as any };
  const code = ts.transpileModule(readFileSync("src/lib/perf/playback-trace.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", "performance", "setInterval", "clearInterval", code)(
    () => ({
      tracePlayback: (line: string) => native.push(line),
      dlog: (line: string) => logs.push(line),
    }),
    module,
    module.exports,
    { now: () => at, mark() {}, measure() {} },
    (callback: () => void) => {
      tick = callback;
      return 1;
    },
    () => {
      cleared = true;
    },
  );
  return {
    api: module.exports,
    logs,
    native,
    time: (value: number) => {
      at = value;
    },
    tick: () => tick?.(),
    cleared: () => cleared,
  };
}

test("startup timings retain pre-mpv stages and report elapsed and step time", () => {
  const f = fixture(),
    id = f.api.beginPlaybackTrace("direct");
  f.time(100);
  f.api.markPlaybackTrace(id, "resolve-ready");
  assert.equal(f.native.length, 0);
  f.time(350);
  f.api.markPlaybackTrace(id, "loadfile-accepted");
  assert.equal(f.native.length, 3);
  assert.match(f.native[2], /elapsed_ms=350 since=resolve-ready step_ms=250/);
  f.api.markPlaybackTrace(id, "loadfile-accepted");
  assert.equal(f.native.length, 3);
  f.time(10_000);
  f.tick();
  assert.match(f.native.at(-1)!, /waiting stage=loadfile-accepted elapsed_ms=10000 stage_ms=9650/);
  f.api.finishPlaybackTrace(id, "ready");
  assert.equal(f.cleared(), true);
  const count = f.logs.length;
  f.tick();
  assert.equal(f.logs.length, count);
});

test("aborted startup stops waiting diagnostics before native readiness", () => {
  const f = fixture(),
    id = f.api.beginPlaybackTrace("p2p");
  f.api.finishPlaybackTrace(id, "aborted");
  f.tick();
  assert.equal(f.logs.length, 2);
  assert.equal(f.native.length, 0);
  assert.equal(f.cleared(), true);
});

test("diagnostic expiry does not claim that playback was aborted", () => {
  const f = fixture();
  f.api.beginPlaybackTrace("unknown");
  f.time(310_000);
  f.tick();
  assert.match(f.logs.at(-1)!, /trace-expired/);
  assert.equal(f.cleared(), true);
});

test("stage durations remain accurate across intervening UI milestones", () => {
  const f = fixture(),
    id = f.api.beginPlaybackTrace("direct");
  f.time(10);
  f.api.markPlaybackTrace(id, "resolve-start");
  f.time(30);
  f.api.markPlaybackTrace(id, "redirect-start");
  f.time(80);
  f.api.markPlaybackTrace(id, "redirect-ready");
  assert.match(f.logs.at(-1)!, /duration_ms=50/);
  f.api.markPlaybackTrace(id, "resolve-ready");
  assert.match(f.logs.at(-1)!, /duration_ms=70/);
  f.time(100);
  f.api.markPlaybackTrace(id, "resume-start");
  f.time(150);
  f.api.markPlaybackTrace(id, "loader-shown");
  f.time(600);
  f.api.markPlaybackTrace(id, "resume-ready");
  assert.match(f.logs.at(-1)!, /duration_ms=500/);
  f.time(610);
  f.api.markPlaybackTrace(id, "loadfile-requested");
  f.time(650);
  f.api.markPlaybackTrace(id, "loadfile-accepted");
  f.time(800);
  f.api.markPlaybackTrace(id, "first-frame");
  assert.match(f.native.at(-1)!, /duration_ms=190/);
  f.api.finishPlaybackTrace(id);
});

test("first frame does not finish a trace while resume position is pending", () => {
  const f = fixture(),
    id = f.api.beginPlaybackTrace("direct");
  f.api.markPlaybackTrace(id, "resume.position-pending");
  f.time(100);
  f.api.markPlaybackTrace(id, "first-frame");
  f.api.finishPlaybackTrace(id);
  assert.equal(f.cleared(), false);
  f.time(450);
  f.api.markPlaybackTrace(id, "resume.position-confirmed");
  assert.match(f.logs.at(-2)!, /resume.position-confirmed.*duration_ms=450/);
  assert.match(f.logs.at(-1)!, /ready source=direct total_ms=450/);
  assert.equal(f.cleared(), true);
});

test("resume position confirmed before first frame still waits for first frame", () => {
  const f = fixture(),
    id = f.api.beginPlaybackTrace("direct");
  f.api.markPlaybackTrace(id, "resume.position-pending");
  f.api.markPlaybackTrace(id, "resume.position-confirmed");
  assert.equal(f.cleared(), false);
  f.time(200);
  f.api.markPlaybackTrace(id, "first-frame");
  f.api.finishPlaybackTrace(id);
  assert.match(f.logs.at(-1)!, /total_ms=200/);
  assert.equal(f.cleared(), true);
});
