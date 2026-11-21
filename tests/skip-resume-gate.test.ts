import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness } from "./helpers/hook-harness.ts";
import {
  resolveSkipPillProgress,
  resolveSkipPillWindowMs,
  resolveSkipPillWindowProgress,
} from "../src/lib/skip-intro/pill-progress";

test("a valid zero-start intro waits for playback and remains skippable after resume resolves", () => {
  let position = 0;
  const skips: number[] = [];
  const segment = { kind: "intro", startSec: 0, endSec: 90, source: "chapters" };
  const h = hookHarness("src/views/player/skip-pill-container.tsx", "SkipPillContainer", {
    "react/jsx-runtime": { jsx: (_type: any, props: any) => props },
    "@/lib/player/playback-clock": {
      usePlaybackPosition: () => position,
      getPlaybackPosition: () => position,
    },
    "@/components/player/skip-pill": { SkipPill() {} },
    "@/views/big-picture/player/bp-skip-pill": { BpSkipPill() {} },
    "@/lib/skip-intro": {
      activeSegment: (_segments: any, at: number) => (at < 90 ? segment : null),
      resolveSkipPillProgress,
      resolveSkipPillWindowMs,
      resolveSkipPillWindowProgress,
    },
    "@/lib/settings": {
      useSettings: () => ({
        settings: {
          autoSkipIntro: true,
          nextEpisodeLeadSec: 0,
          showSkipButton: true,
          skipButtonHideSec: 0,
        },
      }),
    },
  });
  const args = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: (sec: number) => skips.push(sec),
  };
  h.render(args);
  position = 1;
  h.render(args);
  assert.deepEqual(skips, [], "pending resume owns the seek");
  position = 0;
  args.allowAutoSkip = true;
  h.render(args);
  assert.deepEqual(skips, [], "a reset clock is not evidence playback started");
  position = 1;
  h.render(args);
  position = 2;
  h.render(args);
  assert.deepEqual(skips, [90], "valid zero-start intros still skip once");
});

test("the pill line starts empty where the pill appeared and advances with the clock", () => {
  let position = 12;
  const segment = { kind: "intro", startSec: 12, endSec: 92, source: "chapters" };
  const h = hookHarness("src/views/player/skip-pill-container.tsx", "SkipPillContainer", {
    "react/jsx-runtime": { jsx: (_type: any, props: any) => props },
    "@/lib/player/playback-clock": {
      usePlaybackPosition: () => position,
      getPlaybackPosition: () => position,
    },
    "@/components/player/skip-pill": { SkipPill() {} },
    "@/views/big-picture/player/bp-skip-pill": { BpSkipPill() {} },
    "@/lib/skip-intro": {
      activeSegment: (_segments: any, at: number) => (at >= 12 && at < 92 ? segment : null),
      resolveSkipPillProgress,
      resolveSkipPillWindowMs,
      resolveSkipPillWindowProgress,
    },
    "@/lib/settings": {
      useSettings: () => ({
        settings: {
          autoSkipIntro: false,
          nextEpisodeLeadSec: 0,
          showSkipButton: true,
          skipButtonHideSec: 0,
        },
      }),
    },
  });
  const args = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: () => {},
  };
  const first = h.render(args);
  assert.equal(first.progress, 0, "the line starts empty, not part-filled");
  position = (12 + 91.25) / 2;
  const middle = h.render(args);
  assert.equal(middle.progress, 0.5);
});

function containerHarness(active: (at: number) => any, hideSec: number, position: () => number) {
  return hookHarness(
    "src/views/player/skip-pill-container.tsx",
    "SkipPillContainer",
    {
      "react/jsx-runtime": { jsx: (_type: any, props: any) => props },
      "@/lib/player/playback-clock": {
        usePlaybackPosition: position,
        getPlaybackPosition: position,
      },
      "@/components/player/skip-pill": { SkipPill() {} },
      "@/views/big-picture/player/bp-skip-pill": { BpSkipPill() {} },
      "@/lib/skip-intro": {
        activeSegment: (_segments: any, at: number) => active(at),
        resolveSkipPillProgress,
        resolveSkipPillWindowMs,
        resolveSkipPillWindowProgress,
      },
      "@/lib/settings": {
        useSettings: () => ({
          settings: {
            autoSkipIntro: false,
            nextEpisodeLeadSec: 15,
            showSkipButton: true,
            skipButtonHideSec: hideSec,
          },
        }),
      },
    },
    {
      window: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
      },
    },
  );
}

test("the hide window runs on real time, not playback", () => {
  let position = 12;
  const segment = { kind: "intro", startSec: 12, endSec: 92, source: "chapters" };
  const h = containerHarness(
    (at) => (at >= 12 && at < 92 ? segment : null),
    10,
    () => position,
  );
  const args = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: () => {},
    visible: true,
  };
  h.render(args);
  position = 22; // ten playback seconds later; the wall clock has barely moved
  const ahead = h.render(args);
  assert.equal(ahead.segment?.kind, "intro", "playback time must not retire the pill");
  assert.ok(ahead.progress < 0.2, "the line follows the wall clock, not the video");
  h.unmount();
});

test("the window retires the pill once its real time is up", async () => {
  let position = 12;
  const segment = { kind: "intro", startSec: 12, endSec: 92, source: "chapters" };
  const h = containerHarness(
    (at) => (at >= 12 && at < 92 ? segment : null),
    0.05,
    () => position,
  );
  const args = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: () => {},
    visible: true,
  };
  h.render(args);
  assert.equal(h.render(args).segment?.kind, "intro");
  await new Promise((resolve) => setTimeout(resolve, 130));
  h.render(args);
  assert.equal(h.render(args).segment, null, "the window closed the pill");
  h.unmount();
});

test("an ad skip pill is never retired by the hide window", async () => {
  const position = 120;
  const ad = { kind: "ad", startSec: 100, endSec: 200, source: "adcorpus" };
  const h = containerHarness(
    (at) => (at >= 100 && at < 200 ? ad : null),
    0.05,
    () => position,
  );
  const args = {
    skipSegments: [ad],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: () => {},
    visible: true,
  };
  h.render(args);
  await new Promise((resolve) => setTimeout(resolve, 130));
  h.render(args);
  assert.equal(h.render(args).segment?.kind, "ad", "the ad's escape hatch outlives the window");
  h.unmount();
});

test("the hide window does not run while the pill cannot be seen", async () => {
  const position = 12;
  const segment = { kind: "intro", startSec: 12, endSec: 92, source: "chapters" };
  const h = containerHarness(
    (at) => (at >= 12 && at < 92 ? segment : null),
    0.05,
    () => position,
  );
  const base = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: false,
    allowAutoSkip: false,
    onSkip: () => {},
  };
  h.render({ ...base, visible: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  h.render({ ...base, visible: false });
  assert.equal(
    h.render({ ...base, visible: false }).segment?.kind,
    "intro",
    "time spent behind the resume prompt is not charged to the window",
  );
  h.render({ ...base, visible: true });
  await new Promise((resolve) => setTimeout(resolve, 130));
  h.render({ ...base, visible: true });
  assert.equal(
    h.render({ ...base, visible: true }).segment,
    null,
    "the window starts once the pill can be seen",
  );
  h.unmount();
});

test("the credits pill survives its hide window so the Up Next card can appear", () => {
  let position = 1700;
  const segment = { kind: "outro", startSec: 1700, endSec: 1800, source: "chapters" };
  const h = containerHarness(
    (at) => (at >= 1700 && at < 1800 ? segment : null),
    10,
    () => position,
  );
  const args = {
    skipSegments: [segment],
    durationSec: 1800,
    hasNextEpisode: true,
    hasNextEpDisplay: true,
    nextEp: { name: "Next" },
    allowAutoSkip: false,
    onSkip: () => {},
  };
  h.render(args);
  position = 1710;
  const afterWindow = h.render(args);
  assert.ok(
    afterWindow.progress < 0.2,
    "the line keeps following the segment instead of finishing at the hide window",
  );
  assert.equal(h.render(args).segment?.kind, "outro", "the card's entry point is not retired");
});

const upNextArgs = {
  durationSec: 1800,
  hasNextEpisode: true,
  hasNextEpDisplay: true,
  nextEp: { name: "Next" },
  allowAutoSkip: false,
  onSkip: () => {},
};

test("credits that stop before the file does do not offer the next episode", () => {
  const position = 1710;
  const credits = { kind: "outro", startSec: 1700, endSec: 1750, source: "skipdb" };
  const h = containerHarness(
    (at) => (at >= 1700 && at < 1750 ? credits : null),
    0,
    () => position,
  );
  const probe = h.render({ ...upNextArgs, skipSegments: [credits] });
  assert.equal(probe.segment?.kind, "outro");
  assert.equal(
    probe.hasNextEp,
    false,
    "a preview or after-credits scene follows, so the action must stay Skip Credits",
  );
});

test("credits that run into the end still offer the next episode", () => {
  const position = 1710;
  const credits = { kind: "outro", startSec: 1700, endSec: 1800, source: "skipdb" };
  const h = containerHarness(
    (at) => (at >= 1700 && at < 1800 ? credits : null),
    0,
    () => position,
  );
  const probe = h.render({ ...upNextArgs, skipSegments: [credits] });
  assert.equal(probe.segment?.kind, "outro");
  assert.equal(probe.hasNextEp, true);
});

test("an early-ending outro does not suppress the Up Next card at the real end", () => {
  const position = 1790;
  const credits = { kind: "outro", startSec: 1700, endSec: 1750, source: "skipdb" };
  const h = containerHarness(
    (at) => (at >= 1700 && at < 1750 ? credits : null),
    0,
    () => position,
  );
  const probe = h.render({ ...upNextArgs, skipSegments: [credits] });
  assert.equal(probe.segment?.kind, "outro", "the synthetic outro covers the real tail");
  assert.ok(probe.segment.startSec > credits.endSec);
  assert.equal(probe.hasNextEp, true);
});
