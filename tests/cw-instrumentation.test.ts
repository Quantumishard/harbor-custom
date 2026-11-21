// CW instrumentation must capture a fixed cohort and settle every entry.
import assert from "node:assert/strict";
import test from "node:test";
import {
  cwAdvanceCancel,
  cwAdvanceCandidates,
  cwAdvanceComplete,
  cwAdvanceOutcome,
  cwAdvanceStart,
  cwAnimeWarmEnd,
  cwAnimeWarmStart,
  cwCaptureCohort,
  cwMarkEmptyState,
  cwMarkFirstVisible,
  cwMutation,
  cwStaleComplete,
  cwStaleStart,
  resetCwInstrumentation,
} from "../src/lib/cw-instrumentation.ts";
import { resetStartupTrace, startupMarkOnce, startupSnapshot } from "../src/lib/startup-trace.ts";

function cwEvents() {
  return startupSnapshot().events.filter((event) => event.name.startsWith("cw."));
}

test("an empty capture does not create a permanent cohort", () => {
  resetStartupTrace();
  resetCwInstrumentation();
  cwCaptureCohort([]);
  assert.equal(cwEvents().length, 0);
  cwCaptureCohort([{ _id: "a" }, { _id: "b" }]);
  const capture = cwEvents().find((event) => event.name === "cw.cohort.capture");
  assert.equal(Array.isArray(capture?.detail?.ids) ? capture.detail.ids.length : 0, 2);
  cwMarkFirstVisible();
  assert.ok(cwEvents().some((event) => event.name === "cw.first.visible"));
  resetCwInstrumentation();
});

test("cohort outcomes settle independently of failed work", () => {
  resetStartupTrace();
  resetCwInstrumentation();
  cwCaptureCohort([{ _id: "a" }, { _id: "b" }, { _id: "c" }]);
  const pass = cwAdvanceStart();
  assert.ok(pass != null);
  cwAdvanceCandidates(["a", "b"], pass);
  cwAdvanceOutcome("a", "failure", pass);
  cwAdvanceOutcome("b", "success", pass);
  cwAdvanceComplete(pass);

  const settled = cwEvents().find((event) => event.name === "cw.advance.cohort.settled");
  assert.deepEqual(settled?.detail, {
    settled: 3,
    success: 2,
    failed: 1,
  });
  assert.equal(cwEvents().filter((event) => event.name === "cw.cohort.outcome").length, 3);
  resetCwInstrumentation();
});

test("a quiet observation window records the mutation tail and ends", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const pass = cwAdvanceStart();
  cwAdvanceCandidates(["a"], pass);
  cwAdvanceOutcome("a", "success", pass);
  cwAdvanceComplete(pass);
  cwMutation("insert");
  t.mock.timers.tick(750);

  const end = cwEvents().find((event) => event.name === "cw.mutation.end");
  assert.equal(end?.detail?.reason, "quiet");
  assert.equal(end?.detail?.mutations, 1);
  assert.equal(end?.detail?.settled, 1);
  resetCwInstrumentation();
});

test("visible resolved waits for identity work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const pass = cwAdvanceStart();
  cwAdvanceCandidates(["a"], pass);
  cwAdvanceOutcome("a", "success", pass);
  cwAnimeWarmStart();
  cwAdvanceComplete(pass);
  t.mock.timers.tick(750);
  assert.equal(
    cwEvents().some((event) => event.name === "cw.visible.cohort.resolved"),
    false,
  );
  assert.equal(
    cwEvents().some((event) => event.name === "cw.mutation.end"),
    false,
  );

  cwAnimeWarmEnd();
  t.mock.timers.tick(750);
  assert.equal(
    cwEvents().some((event) => event.name === "cw.visible.cohort.resolved"),
    true,
  );
  assert.equal(
    cwEvents().some((event) => event.name === "cw.mutation.end"),
    true,
  );
  assert.equal(
    cwEvents().find((event) => event.name === "cw.mutation.end")?.detail?.lastMutationAt,
    null,
  );
  resetCwInstrumentation();
});

test("a late mutation resets the quiet window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const pass = cwAdvanceStart();
  cwAdvanceCandidates(["a"], pass);
  cwAdvanceOutcome("a", "success", pass);
  cwAdvanceComplete(pass);
  t.mock.timers.tick(500);
  cwMutation("insert");
  t.mock.timers.tick(500);
  assert.equal(
    cwEvents().some((event) => event.name === "cw.mutation.end"),
    false,
  );
  t.mock.timers.tick(250);
  const end = cwEvents().find((event) => event.name === "cw.mutation.end");
  assert.equal(end?.detail?.reason, "quiet");
  assert.equal(end?.detail?.mutations, 1);
  resetCwInstrumentation();
});

test("an obsolete pass cannot close the current pass stage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const first = cwAdvanceStart();
  cwStaleStart(first);
  const second = cwAdvanceStart();
  cwStaleStart(second);
  cwAdvanceCandidates([], second);
  cwAdvanceComplete(second);

  cwStaleComplete(first);
  assert.equal(
    cwEvents().some((event) => event.name === "cw.visible.cohort.resolved"),
    false,
  );
  cwStaleComplete(second);
  t.mock.timers.tick(750);
  assert.equal(
    cwEvents().some((event) => event.name === "cw.visible.cohort.resolved"),
    true,
  );
  resetCwInstrumentation();
});

test("a cancelled pass settles its cohort entries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const pass = cwAdvanceStart();
  cwAdvanceCancel(pass);
  t.mock.timers.tick(250);
  const outcome = cwEvents().find((event) => event.name === "cw.cohort.outcome");
  assert.equal(outcome?.detail?.outcome, "cancelled");
  resetCwInstrumentation();
});

test("the hard timeout settles pending cohort entries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetStartupTrace();
  resetCwInstrumentation();
  startupMarkOnce("root.revealed");
  cwCaptureCohort([{ _id: "a" }]);
  const pass = cwAdvanceStart();
  assert.ok(pass != null);
  t.mock.timers.tick(10_000);
  const outcome = cwEvents().find((event) => event.name === "cw.cohort.outcome");
  const resolved = cwEvents().find((event) => event.name === "cw.visible.cohort.resolved");
  const end = cwEvents().find((event) => event.name === "cw.mutation.end");
  assert.equal(outcome?.detail?.outcome, "timeout");
  assert.equal(resolved?.detail?.timedOut, true);
  assert.equal(end?.detail?.reason, "timeout");
  resetCwInstrumentation();
});

test("an empty state is recorded once", () => {
  resetStartupTrace();
  resetCwInstrumentation();
  cwMarkEmptyState();
  cwMarkEmptyState();
  assert.equal(cwEvents().filter((event) => event.name === "cw.empty.paint").length, 1);
  resetCwInstrumentation();
});
