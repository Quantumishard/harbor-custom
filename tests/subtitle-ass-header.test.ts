// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

import {
  computeAssBaseFactor,
  computeAssBaseFactorInfo,
  dominantDialogueStyle,
  parseAssStyles,
} from "../src/lib/player/ass-header.ts";
import {
  resolveAssBaseFactor,
  sidMatchesTrack,
} from "../src/views/player/hooks/use-ass-normalize.ts";
import type { TrackInfo } from "../src/lib/player/bridge.ts";

function assHeader({
  playRes = "PlayResX: 1920\nPlayResY: 1080",
  styles,
  events = "",
}: {
  playRes?: string;
  styles: string;
  events?: string;
}): string {
  return `[Script Info]
${playRes}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;
}

function track(patch: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id: "3",
    label: "Subtitle",
    kind: "subtitle",
    selected: true,
    ...patch,
  };
}

const DEFAULT_72 = assHeader({
  styles: ["Style: Signs,Arial,24,&H00FFFFFF", "Style: Default,Arial,72,&H00FFFFFF"].join("\n"),
});
const DEFAULT_72_FACTOR = 1080 / (720 * 72);

test("a header without dialogue events still normalizes by its Default style", () => {
  assert.equal(computeAssBaseFactor(DEFAULT_72), DEFAULT_72_FACTOR);
});

test("a header without an exact Default picks a group-prefixed dialogue style", () => {
  const header = assHeader({
    styles: ["Style: Signs,Arial,90,&H00FFFFFF", "Style: GJM Default,Arial,60,&H00FFFFFF"].join(
      "\n",
    ),
  });

  assert.equal(computeAssBaseFactor(header), 1080 / (720 * 60));
});

test("a sign style whose name contains Default is not chosen over dialogue", () => {
  const header = assHeader({
    styles: [
      "Style: Signs Default,Arial,90,&H00FFFFFF",
      "Style: GJM Main,Arial,60,&H00FFFFFF",
    ].join("\n"),
  });

  assert.equal(computeAssBaseFactor(header), 1080 / (720 * 60));
});

test("a zero-size Default does not hide another dialogue style", () => {
  const header = assHeader({
    styles: ["Style: Default,Arial,0,&H00FFFFFF", "Style: Dialogue,Arial,48,&H00FFFFFF"].join("\n"),
  });

  assert.equal(computeAssBaseFactor(header), 1080 / (720 * 48));
});

test("a header with only non-dialogue names falls back to the first positive style", () => {
  const header = assHeader({
    styles: ["Style: Typesetting,Arial,30,&H00FFFFFF", "Style: Extra,Arial,40,&H00FFFFFF"].join(
      "\n",
    ),
  });

  assert.equal(computeAssBaseFactor(header), 1080 / (720 * 30));
});

test("dialogue events still decide the dominant style when the file has them", () => {
  const text = assHeader({
    styles: ["Style: Signs,Arial,90,&H00FFFFFF", "Style: Main,Arial,60,&H00FFFFFF"].join("\n"),
    events: [
      "Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(160,40)}Sign",
      "Dialogue: 0,0:00:02.00,0:00:03.00,Main,,0,0,0,,Hello",
      "Dialogue: 0,0:00:03.00,0:00:04.00,Main,,0,0,0,,World",
    ].join("\n"),
  });

  assert.equal(dominantDialogueStyle(text, parseAssStyles(text)), "Main");
  assert.equal(computeAssBaseFactor(text), 1080 / (720 * 60));
  assert.equal(computeAssBaseFactorInfo(text)?.confident, true);
});

test("a header-only style pick reports whether it used a conventional dialogue name", () => {
  assert.equal(computeAssBaseFactorInfo(DEFAULT_72)?.confident, true);

  const guessed = assHeader({ styles: "Style: Typesetting,Arial,30,&H00FFFFFF" });
  assert.equal(computeAssBaseFactorInfo(guessed)?.confident, false);
});

test("mpv's sid still has to name the selected subtitle track", () => {
  assert.equal(sidMatchesTrack(3, "3"), true);
  assert.equal(sidMatchesTrack("3", "3"), true);
  assert.equal(sidMatchesTrack(4, "3"), false);
  assert.equal(sidMatchesTrack("no", "3"), false);
  assert.equal(sidMatchesTrack(false, "3"), false);
  assert.equal(sidMatchesTrack(null, "3"), false);
});

test("embedded ASS tracks use mpv's parsed header without opening the media again", async () => {
  let textLoads = 0;
  let requestedTrack = "";
  let provisionalCalls = 0;
  const result = await resolveAssBaseFactor({
    sourceUrl: "https://video.test/show.mkv",
    track: track(),
    tracks: [],
    readMpvHeader: async (id) => {
      requestedTrack = id;
      return DEFAULT_72;
    },
    loadText: async () => {
      textLoads += 1;
      return null;
    },
    onProvisional: () => {
      provisionalCalls += 1;
    },
  });

  assert.equal(result?.factor, DEFAULT_72_FACTOR);
  assert.equal(result?.provisional, false);
  assert.equal(requestedTrack, "3");
  assert.equal(textLoads, 0);
  assert.equal(provisionalCalls, 0);
});

test("a missing mpv header still falls back to extracting the embedded track", async () => {
  let textLoads = 0;
  const result = await resolveAssBaseFactor({
    sourceUrl: "https://video.test/show.mkv",
    track: track(),
    tracks: [],
    readMpvHeader: async () => null,
    loadText: async () => {
      textLoads += 1;
      return DEFAULT_72;
    },
  });

  assert.equal(result?.factor, DEFAULT_72_FACTOR);
  assert.equal(result?.provisional, false);
  assert.equal(textLoads, 1);
});

test("a prepared local ASS file is read before asking mpv", async () => {
  let headerReads = 0;
  const result = await resolveAssBaseFactor({
    sourceUrl: "C:/video.mkv",
    track: track({ external: true, externalFilename: "C:/subs/show.ass" }),
    tracks: [],
    readMpvHeader: async () => {
      headerReads += 1;
      return null;
    },
    loadText: async () => DEFAULT_72,
  });

  assert.equal(result?.factor, DEFAULT_72_FACTOR);
  assert.equal(result?.provisional, false);
  assert.equal(headerReads, 0);
});

test("an unreadable prepared file still falls back to mpv's header", async () => {
  const result = await resolveAssBaseFactor({
    sourceUrl: "C:/video.mkv",
    track: track({ external: true, externalFilename: "C:/subs/missing.ass" }),
    tracks: [],
    readMpvHeader: async () => DEFAULT_72,
    loadText: async () => {
      throw new Error("missing");
    },
  });

  assert.equal(result?.factor, DEFAULT_72_FACTOR);
  assert.equal(result?.provisional, false);
});

test("an ambiguous header publishes its guess immediately and refines it", async () => {
  const ambiguousHeader = assHeader({
    styles: ["Style: Signs,Arial,90,&H00FFFFFF", "Style: Content,Arial,60,&H00FFFFFF"].join("\n"),
  });
  const exactText = assHeader({
    styles: ["Style: Signs,Arial,90,&H00FFFFFF", "Style: Content,Arial,60,&H00FFFFFF"].join("\n"),
    events: [
      "Dialogue: 0,0:00:01.00,0:00:02.00,Content,,0,0,0,,Hello",
      "Dialogue: 0,0:00:02.00,0:00:03.00,Content,,0,0,0,,Again",
    ].join("\n"),
  });
  let provisional: number | undefined;
  let textLoads = 0;
  const result = await resolveAssBaseFactor({
    sourceUrl: "https://video.test/show.mkv",
    track: track(),
    tracks: [],
    readMpvHeader: async () => ambiguousHeader,
    loadText: async () => {
      textLoads += 1;
      return exactText;
    },
    onProvisional: (factor) => {
      provisional = factor;
    },
  });

  assert.equal(provisional, 1080 / (720 * 90));
  assert.equal(result?.factor, 1080 / (720 * 60));
  assert.equal(result?.provisional, false);
  assert.equal(textLoads, 1);
});

test("a failed refinement keeps the header guess provisional", async () => {
  const ambiguousHeader = assHeader({
    styles: ["Style: Signs,Arial,90,&H00FFFFFF", "Style: Content,Arial,60,&H00FFFFFF"].join("\n"),
  });
  let provisional: number | undefined;
  const result = await resolveAssBaseFactor({
    sourceUrl: "https://video.test/show.mkv",
    track: track(),
    tracks: [],
    readMpvHeader: async () => ambiguousHeader,
    loadText: async () => null,
    onProvisional: (factor) => {
      provisional = factor;
    },
  });

  assert.equal(provisional, 1080 / (720 * 90));
  assert.equal(result?.factor, 1080 / (720 * 90));
  assert.equal(result?.provisional, true);
});

test("a cancelled resolve never reads or publishes a stale factor", async () => {
  let headerReads = 0;
  const result = await resolveAssBaseFactor({
    sourceUrl: "https://video.test/show.mkv",
    track: track(),
    tracks: [],
    isCancelled: () => true,
    readMpvHeader: async () => {
      headerReads += 1;
      return DEFAULT_72;
    },
    loadText: async () => DEFAULT_72,
  });

  assert.equal(result, null);
  assert.equal(headerReads, 0);
});
