// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  SEEK_STEP_OPTIONS,
  sanitizeHalfSpeedRate,
  sanitizeSeekStep,
  seekStepChoices,
  slowSpeedToggleRate,
  stepPlaybackRate,
} from "../src/lib/seek-step.ts";
import { formatBindingForDisplay } from "../src/lib/hotkeys.ts";

const at = (p: string) => new URL(`../${p}`, import.meta.url);
const btn = readFileSync(at("src/components/player/transport/seek-step-btn.tsx"), "utf8");
const keys = readFileSync(at("src/views/player/hooks/use-keyboard-shortcuts.ts"), "utf8");

test("step seeks use exact mode and retain Linux media notifications", () => {
  const controls = readFileSync(at("src/views/player/hooks/use-playback-controls.ts"), "utf8");
  const step = controls.slice(
    controls.indexOf("const seekStep ="),
    controls.indexOf("const seekTo ="),
  );
  assert.match(step, /seek\(target, "exact"\);\s*notifyMediaSeeked\(target\)/);
  assert.match(step, /observed !== acc.clock && observed < acc.target - SEEK_REBASE_TOLERANCE_SEC/);
  assert.match(step, /clock: observed/);
});

test("the picker offers both seek steps, not just the arrow one", () => {
  assert.match(btn, /const shortSeconds = sanitizeSeekStep\(/);
  assert.match(btn, /settings\.seekBackStepShortSec : settings\.seekForwardStepShortSec/);
  assert.equal(btn.match(/<SeekGroup/g)?.length, 2);
  assert.match(btn, /label=\{t\("Arrows"\)\}/);
  assert.match(btn, /label=\{t\("Shift \+ Arrows"\)\}/);
});

test("each column writes the setting its own shortcut reads", () => {
  assert.match(btn, /update\(\{ seekBackStepSec: s \}\)/);
  assert.match(btn, /update\(\{ seekForwardStepSec: s \}\)/);
  assert.match(btn, /update\(\{ seekBackStepShortSec: s \}\)/);
  assert.match(btn, /update\(\{ seekForwardStepShortSec: s \}\)/);
  assert.match(keys, /seekStep\(-seekBackStepShortSec\)/);
  assert.match(keys, /seekStep\(seekForwardStepShortSec\)/);
});

test("both columns offer the same presets and accept any step in range", () => {
  assert.deepEqual([...SEEK_STEP_OPTIONS], [1, 3, 5, 10, 15, 30, 60, 90]);
  for (const s of SEEK_STEP_OPTIONS) assert.equal(sanitizeSeekStep(s, 10), s);
  assert.equal(sanitizeSeekStep(7, 10), 7, "a value between presets is kept");
  assert.equal(sanitizeSeekStep(2.5, 10), 2.5);
  assert.equal(sanitizeSeekStep(0.04, 10), 10, "below the minimum falls back");
  assert.equal(sanitizeSeekStep(601, 10), 10, "above the maximum falls back");
  assert.equal(sanitizeSeekStep(Number.NaN, 10), 10);
  assert.equal(sanitizeSeekStep(undefined, 3), 3);
});

test("a custom step stays visible among the presets", () => {
  assert.deepEqual(seekStepChoices(7, [5, 10, 30]), [5, 7, 10, 30]);
  assert.deepEqual(seekStepChoices(10, [5, 10, 30]), [5, 10, 30]);
});

test("the slow speed accepts any rate below 1x", () => {
  assert.equal(sanitizeHalfSpeedRate(0.4, 0.5), 0.4);
  assert.equal(sanitizeHalfSpeedRate(0.755, 0.5), 0.76);
  assert.equal(sanitizeHalfSpeedRate(0.99, 0.5), 0.99);
  assert.equal(sanitizeHalfSpeedRate(1, 0.5), 0.5, "1x would leave the toggle nothing to do");
  assert.equal(sanitizeHalfSpeedRate(1.5, 0.5), 0.5, "the slow speed never speeds up");
  assert.equal(sanitizeHalfSpeedRate(0, 0.5), 0.5);
  assert.equal(sanitizeHalfSpeedRate("0.4", 0.5), 0.5);
});

test("the slow speed toggle goes to the slow speed and back to normal", () => {
  assert.equal(slowSpeedToggleRate(1, 0.5), 0.5);
  assert.equal(slowSpeedToggleRate(1.5, 0.5), 0.5, "from any other speed it goes slow");
  assert.equal(slowSpeedToggleRate(0.5, 0.5), 1);
  assert.equal(slowSpeedToggleRate(0.5004, 0.5), 1, "a rate within the tolerance counts as slow");
  assert.equal(slowSpeedToggleRate(0.51, 0.5), 0.5);
});

test("speed down and up never move the rate the other way", () => {
  assert.equal(stepPlaybackRate(1, -0.25), 0.75);
  assert.equal(stepPlaybackRate(1, 0.25), 1.25);
  assert.equal(stepPlaybackRate(0.3, -0.25), 0.25, "stops at the lowest rate");
  assert.equal(stepPlaybackRate(0.1, -0.25), 0.1, "a slower slow speed is not raised");
  assert.equal(stepPlaybackRate(2.9, 0.25), 3, "stops at the highest rate");
  assert.equal(stepPlaybackRate(0.1, 0.25), 0.35);
});

test("a shortcut with no key shows a dash", () => {
  assert.equal(formatBindingForDisplay(""), "—");
  assert.equal(formatBindingForDisplay("shift+ArrowLeft"), "Shift + ←");
});

test("the long seek hotkeys read their own settings", () => {
  assert.match(keys, /seekStep\(-seekBackStepLongSec\)/);
  assert.match(keys, /seekStep\(seekForwardStepLongSec\)/);
});

test("the short column falls back to the shipped default", () => {
  const defaults = readFileSync(at("src/lib/settings/defaults.ts"), "utf8");
  assert.match(defaults, /seekBackStepShortSec: 3/);
  assert.match(defaults, /seekForwardStepShortSec: 3/);
  assert.match(btn, /const DEFAULT_SHORT_SEC = 3;/);
});

test("speed steps accept any value from 0.01x to 1x", async () => {
  const { sanitizeSpeedStep } = await import("../src/lib/seek-step.ts");
  assert.equal(sanitizeSpeedStep(0.1, 0.25), 0.1);
  assert.equal(sanitizeSpeedStep(0.333, 0.25), 0.33);
  assert.equal(sanitizeSpeedStep(0, 0.25), 0.25);
  assert.equal(sanitizeSpeedStep(5, 0.25), 0.25);
  assert.equal(sanitizeSpeedStep("x", 0.25), 0.25);
});
