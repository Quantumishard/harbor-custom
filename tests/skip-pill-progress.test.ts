// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  resolveSkipPillProgress,
  resolveSkipPillWindowMs,
  resolveSkipPillWindowProgress,
  SKIP_SEGMENT_END_GUARD_SEC,
} from "../src/lib/skip-intro/pill-progress";

const SEGMENT = { kind: "intro" as const, startSec: 12, endSec: 92, source: "chapters" as const };
const GUARD_END = SEGMENT.endSec - SKIP_SEGMENT_END_GUARD_SEC;

const lineAt = (positionSec: number, appearedAtSec: number) =>
  resolveSkipPillProgress({ segment: SEGMENT, positionSec, appearedAtSec });

test("the line runs from where the pill appeared to the segment guard", () => {
  assert.equal(lineAt(12, 12), 0);
  assert.equal(lineAt((12 + GUARD_END) / 2, 12), 0.5);
  assert.equal(lineAt(GUARD_END, 12), 1);
});

test("position outside the window clamps instead of overshooting", () => {
  assert.equal(lineAt(0, 12), 0);
  assert.equal(lineAt(GUARD_END + 30, 12), 1);
});

test("resuming mid-intro starts a fresh line instead of a partial one", () => {
  assert.equal(lineAt(60, 60), 0);
  assert.equal(lineAt(70, 60), (70 - 60) / (GUARD_END - 60));
});

test("the auto-hide window is a real-time duration capped by the segment", () => {
  assert.equal(resolveSkipPillWindowMs({ segment: SEGMENT, appearedAtSec: 12, hideSec: 0 }), 0);
  assert.equal(
    resolveSkipPillWindowMs({ segment: SEGMENT, appearedAtSec: 12, hideSec: 10 }),
    10000,
  );
  // Only three seconds of the segment are left, so the pill cannot outlive it.
  assert.equal(resolveSkipPillWindowMs({ segment: SEGMENT, appearedAtSec: 89, hideSec: 10 }), 2250);
  assert.equal(resolveSkipPillWindowMs({ segment: SEGMENT, appearedAtSec: 95, hideSec: 10 }), 0);
});

test("window progress is elapsed real time over the window", () => {
  assert.equal(resolveSkipPillWindowProgress(0, 10000), 0);
  assert.equal(resolveSkipPillWindowProgress(5000, 10000), 0.5);
  assert.equal(resolveSkipPillWindowProgress(10000, 10000), 1);
  assert.equal(resolveSkipPillWindowProgress(15000, 10000), 1);
  assert.equal(resolveSkipPillWindowProgress(500, 0), 0);
});
