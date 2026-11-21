// The export contains the live snapshot and the persisted history; one launch
// must count once even though those timestamps differ.
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeStartupTraces } from "../scripts/startup-trace-summary.mjs";

test("a completed launch exported twice is counted once", () => {
  const trace = {
    launchId: "launch-1",
    at: 100,
    measures: [{ name: "root-revealed", ms: 1800 }],
  };
  const summary = summarizeStartupTraces({ current: trace, traces: [trace] });
  assert.equal(summary.launches, 1);
  assert.equal(summary.rows[0].n, 1);
});

test("the post-reveal snapshot replaces the same launch", () => {
  const early = {
    launchId: "launch-1",
    at: 100,
    measures: [{ name: "root-revealed", ms: 1800 }],
  };
  const late = {
    launchId: "launch-1",
    at: 500,
    measures: [
      { name: "root-revealed", ms: 1800 },
      { name: "root-revealed→navigation-usable", ms: 90 },
    ],
  };
  const summary = summarizeStartupTraces({ traces: [early, late] });
  assert.equal(summary.launches, 1);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.find((row) => row.name === "root-revealed").n, 1);
});

test("different launches remain separate samples", () => {
  const summary = summarizeStartupTraces({
    traces: [
      { launchId: "one", at: 1, measures: [{ name: "start", ms: 100 }] },
      { launchId: "two", at: 2, measures: [{ name: "start", ms: 200 }] },
    ],
  });
  assert.equal(summary.launches, 2);
  assert.equal(summary.rows[0].n, 2);
  assert.equal(summary.rows[0].p50, 100);
});

test("stalled launches are counted but excluded from percentiles", () => {
  const summary = summarizeStartupTraces({
    traces: [
      { launchId: "ok", at: 1, measures: [{ name: "start", ms: 100 }] },
      { launchId: "stuck", at: 2, stalled: true, measures: [{ name: "start", ms: 5 }] },
    ],
  });
  assert.equal(summary.launches, 2);
  assert.equal(summary.stalled, 1);
  assert.equal(summary.rows[0].n, 1);
  assert.equal(summary.rows[0].p50, 100);
});

function cwTrace(launchId, items, refreshed, rootAt, events) {
  return {
    launchId,
    at: Number(launchId.replace(/\D/g, "")) || 1,
    marks: [{ name: "root.revealed", at: rootAt }],
    measures: [],
    events: [
      { name: "cw.cache.ready", at: 0, detail: { items } },
      ...(refreshed ? [{ name: "cw.external.refresh.start", at: rootAt - 100, detail: {} }] : []),
      ...events,
    ],
  };
}

test("CW events are grouped by cached-refreshed, cached-not-refreshed and empty cache", () => {
  const summary = summarizeStartupTraces({
    traces: [
      cwTrace("fresh1", 3, false, 100, [
        { name: "cw.first.visible", at: 120 },
        {
          name: "cw.mutation.end",
          at: 500,
          detail: {
            mutations: 2,
            settled: 3,
            success: 2,
            failed: 1,
            lastMutationAt: 400,
            reason: "quiet",
          },
        },
      ]),
      cwTrace("stale1", 2, true, 200, [
        { name: "cw.first.visible", at: 260 },
        {
          name: "cw.mutation.end",
          at: 800,
          detail: {
            mutations: 4,
            settled: 4,
            success: 4,
            failed: 0,
            lastMutationAt: 700,
            reason: "timeout",
          },
        },
      ]),
      cwTrace("empty1", 0, true, 300, [
        { name: "cw.empty.paint", at: 310 },
        {
          name: "cw.mutation.end",
          at: 600,
          detail: {
            mutations: 0,
            settled: 0,
            success: 0,
            failed: 0,
            lastMutationAt: null,
            reason: "quiet",
          },
        },
      ]),
    ],
  });

  assert.equal(summary.cw["cached-not-refreshed"].launches, 1);
  assert.equal(summary.cw["cached-refreshed"].launches, 1);
  assert.equal(summary.cw.empty.launches, 1);
  assert.equal(
    summary.cw["cached-not-refreshed"].rows.find((row) => row.name === "cw.first.visible")
      ?.p50First,
    20,
  );
  assert.equal(
    summary.cw["cached-refreshed"].rows.find((row) => row.name === "cw.first.visible")?.p50First,
    60,
  );
  assert.equal(summary.cw.empty.rows.find((row) => row.name === "cw.empty.paint")?.p50First, 10);
  assert.equal(summary.cw["cached-not-refreshed"].mutationEnd.mutations.p50, 2);
  assert.equal(summary.cw["cached-refreshed"].mutationEnd.mutations.p50, 4);
  assert.equal(summary.cw.empty.mutationEnd.mutations.p50, 0);
  assert.equal(summary.cw["cached-not-refreshed"].mutationEnd.lastMutation.p50, 300);
  assert.equal(summary.cw["cached-refreshed"].mutationEnd.lastMutation.p50, 500);
  assert.equal(summary.cw.empty.mutationEnd.lastMutation, null);
  assert.equal(summary.cw["cached-not-refreshed"].mutationEnd.quiet, 1);
  assert.equal(summary.cw["cached-refreshed"].mutationEnd.timeout, 1);
});
