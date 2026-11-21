import assert from "node:assert/strict";
import test from "node:test";
import { sameLanguagePlaybackOffset } from "../src/lib/subtitles/autosync/playback-lexical.ts";
import { matchPlaybackSpeech } from "../src/lib/subtitles/autosync/playback-asr.ts";
import { crossLanguagePlaybackOffset } from "../src/lib/subtitles/autosync/drift-dsp.ts";

const dialogue = [
  [3, "The silver compass points toward morning"],
  [13, "Remember the quiet harbor lights are waiting"],
  [24, "Carry these old maps beyond the mountains"],
  [35, "Every distant shoreline carries another story"],
] as const;

function example(shift = 1.35) {
  const cues = dialogue.map(([start, text]) => ({
    start,
    end: start + 7.2,
    text,
  }));
  const tokens = dialogue.flatMap(([start, text]) =>
    text.split(" ").map((word, i) => ({
      text: word,
      t0: start + shift + i * 0.2,
      t1: start + shift + i * 0.2 + 0.15,
    })),
  );
  return { cues, tokens };
}

test("speech words can establish an offset when long displayed captions defeat occupancy", () => {
  const { cues, tokens } = example();
  const timing = crossLanguagePlaybackOffset(
    tokens.map((token) => [token.t0, token.t1] as [number, number]),
    cues.map((cue) => [cue.start, cue.end] as [number, number]),
    [{ startSec: 0, lenSec: 45 }],
    30,
  );
  assert.equal(timing, null);
  const diagnostics: unknown[] = [];
  const offset = sameLanguagePlaybackOffset(tokens, cues, 45, 30, (d) => diagnostics.push(d));
  assert.ok(offset !== null && Math.abs(offset - 1.35) < 0.02);
  assert.deepEqual(diagnostics, [
    { candidates: 4, matches: 4, consistent: 4, spanSec: 32, accepted: true },
  ]);
  assert.ok(!JSON.stringify(diagnostics).includes("silver"), "logs contain only numbers");
});

test("several independent exact cues are necessary, not one repeated phrase", () => {
  const { cues, tokens } = example();
  const repeated = [{ ...cues[0] }, { ...cues[0], start: 8, end: 15 }, cues[1], cues[2]];
  assert.equal(sameLanguagePlaybackOffset(tokens, repeated, 45), null);
  assert.equal(sameLanguagePlaybackOffset(tokens, cues.slice(0, 2), 45), null);
});

test("inconsistent shifts and short matching spans are rejected", () => {
  const { cues, tokens } = example();
  const shifted = tokens.map((token) => ({
    ...token,
    t0: token.t0 + (token.t0 < 15 ? 0 : token.t0 < 27 ? 6 : -5),
    t1: token.t1 + (token.t0 < 15 ? 0 : token.t0 < 27 ? 6 : -5),
  }));
  assert.equal(sameLanguagePlaybackOffset(shifted, cues, 45), null);
  const nearCues = cues.slice(0, 3).map((cue, i) => ({
    ...cue,
    start: i * 4,
    end: i * 4 + 3,
  }));
  const nearTokens = nearCues.flatMap((cue) =>
    cue.text.split(" ").map((word, i) => ({
      text: word,
      t0: cue.start + 1.2 + i * 0.12,
      t1: cue.start + 1.3 + i * 0.12,
    })),
  );
  assert.equal(sameLanguagePlaybackOffset(nearTokens, nearCues, 45), null);
});

test("tokens cannot form a phrase across distant recognition segments", () => {
  const { cues, tokens } = example();
  const torn = tokens.map((token, i) =>
    i === 2 || i === 3 ? { ...token, t0: token.t0 + 17, t1: token.t1 + 17 } : token,
  );
  assert.equal(sameLanguagePlaybackOffset(torn, cues.slice(0, 3), 45), null);
});

test("four independent agreeing cue starts across 8.4 seconds support a scene offset", () => {
  const cues = dialogue.map(([, text], i) => ({ text, start: 2 + i * 2.8, end: 4 + i * 2.8 }));
  const tokens = cues.flatMap((cue) =>
    cue.text.split(" ").map((text, i) => ({
      text,
      t0: cue.start + 1 + i * 0.2,
      t1: cue.start + 1.1 + i * 0.2,
    })),
  );
  assert.equal(sameLanguagePlaybackOffset(tokens, cues, 45), 1);
  assert.equal(sameLanguagePlaybackOffset(tokens, cues.slice(0, 3), 45), null);
  const conflicting = cues.map((cue, i) => (i === 1 ? { ...cue, start: cue.start - 2 } : cue));
  assert.equal(sameLanguagePlaybackOffset(tokens, conflicting, 45), null);
});

test("full playback recognition accepts same-language lexical evidence, even for untagged SRT", async () => {
  const { cues, tokens } = example();
  const windows = [{ startSec: 0, lenSec: 45, tokens, stats: { recognizedLines: 4 } }];
  const calls: string[] = [];
  const invoke = async <T>(command: string): Promise<T> => {
    calls.push(command);
    if (command === "moonshine_model_status")
      return { supported: true, runtimeInstalled: true, installed: true } as T;
    if (command === "moonshine_transcribe_windows") return windows as T;
    throw new Error("unexpected test command");
  };
  for (const subtitleLanguage of ["en", undefined, "und"]) {
    const diagnostics: unknown[] = [];
    const result = await matchPlaybackSpeech(
      {
        path: "private prepared audio",
        durationSec: 45,
        cues: cues.map((cue) => [cue.start, cue.end]),
        textCues: cues,
        audioLanguage: "en",
        subtitleLanguage,
        modelLanguage: "auto",
        enabled: true,
        crossLanguage: false,
        sessionId: "regression",
      },
      invoke,
      () => {},
      () => true,
      undefined,
      undefined,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    assert.ok(Math.abs(result.offsetSec - 1.35) < 0.02);
    assert.equal(diagnostics.length, 1);
  }
  assert.equal(calls.length, 6);

  // The manual override represents the real speech language when a file tags
  // its English audio as Japanese. Its same-language text anchors remain valid.
  const overrideDiagnostics: unknown[] = [];
  const overridden = await matchPlaybackSpeech(
    {
      path: "private prepared audio",
      durationSec: 45,
      cues: cues.map((cue) => [cue.start, cue.end]),
      textCues: cues,
      audioLanguage: "jpn",
      subtitleLanguage: "en",
      modelLanguage: "en",
      enabled: true,
      crossLanguage: true,
      sessionId: "manual-override",
    },
    invoke,
    () => {},
    () => true,
    undefined,
    undefined,
    (diagnostic) => overrideDiagnostics.push(diagnostic),
  );
  assert.ok(Math.abs(overridden.offsetSec - 1.35) < 0.02);
  assert.equal(overrideDiagnostics.length, 1);

  // Known different-language subtitles never use word matching, even if words
  // happen to be identical in the synthetic test fixture.
  await assert.rejects(
    matchPlaybackSpeech(
      {
        path: "private prepared audio",
        durationSec: 45,
        cues: cues.map((cue) => [cue.start, cue.end]),
        textCues: cues,
        audioLanguage: "en",
        subtitleLanguage: "de",
        modelLanguage: "auto",
        enabled: true,
        crossLanguage: true,
        sessionId: "regression",
      },
      invoke,
      () => {},
      () => true,
    ),
    /neither speech timing nor matching dialogue/,
  );
});
