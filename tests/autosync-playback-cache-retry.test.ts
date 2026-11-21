import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheCaptureAttemptPath,
  cacheCaptureRetryReason,
  cacheCaptureScenePath,
  MAX_CACHE_CAPTURE_ATTEMPTS,
} from "../src/lib/subtitles/autosync/playback-cache-retry.ts";

test("only transient cache capture errors are eligible for one fresh attempt", () => {
  for (const reason of [
    "cache-audio-timeline-discontinuous",
    "cache-audio-timeline-discontinuous:main-gap",
    "cache-audio-timeline-discontinuous:anchor-gap",
    "cache-audio-timeline-discontinuous:overlap-shift",
    "cache-audio-timeline-unverified",
    "cache-audio-timeline-cache-timeout",
    "cache-audio-timeline-probe-failed",
    "cache-audio-incomplete",
  ]) {
    assert.equal(cacheCaptureRetryReason(reason), reason);
  }
  for (const reason of [
    "cache-audio-timeline-invalid",
    "cache-audio-timeline-source-timeout",
    "cache-audio-dump-command-failed",
    "cache-subtitle-track-ambiguous",
    "cache-audio-timeline-discontinuous:sensitive/path",
    "arbitrary error",
  ]) {
    assert.equal(cacheCaptureRetryReason(reason), null);
  }
  assert.equal(MAX_CACHE_CAPTURE_ATTEMPTS, 2);
});

test("fresh captures receive distinct paths while respecting the native tap path contract", () => {
  const first = "C:/tmp/harbor-subs/live/tap-456.mkv";
  const second = cacheCaptureAttemptPath(first, 2);
  assert.equal(cacheCaptureAttemptPath(first, 1), first);
  assert.equal(second, "C:/tmp/harbor-subs/live/tap-456-retry-2.mkv");
  assert.notEqual(second, first);
  assert.equal(
    second.replace(/\.mkv$/, "-anchor.mkv"),
    "C:/tmp/harbor-subs/live/tap-456-retry-2-anchor.mkv",
  );
  assert.throws(() => cacheCaptureAttemptPath(first, 3), RangeError);
  assert.throws(
    () => cacheCaptureAttemptPath("C:/bad/cache.wav", 2),
    /Invalid playback cache path/,
  );
});

test("retrying a different dialogue scene never reuses the first scene's cache or anchor", () => {
  const first = "C:/tmp/harbor-subs/live/tap-456.mkv";
  const second = cacheCaptureScenePath(first, 2);
  assert.equal(cacheCaptureScenePath(first, 1), first);
  assert.equal(second, "C:/tmp/harbor-subs/live/tap-456-scene-2.mkv");
  assert.notEqual(second, first);
  assert.equal(
    second.replace(/\.mkv$/, "-anchor.mkv"),
    "C:/tmp/harbor-subs/live/tap-456-scene-2-anchor.mkv",
  );
  assert.notEqual(cacheCaptureAttemptPath(first, 2), cacheCaptureAttemptPath(second, 2));
  assert.throws(() => cacheCaptureScenePath(first, 3), RangeError);
  assert.throws(() => cacheCaptureScenePath("C:/bad/cache.wav", 2), /Invalid playback cache path/);
});

test("the playback hook repeats the full verified capture rather than reusing a failed dump", async () => {
  const { readFile } = await import("node:fs/promises");
  const hook = await readFile(
    new URL("../src/views/player/hooks/use-auto-sync.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /for \(let attempt = 1; attempt <= MAX_CACHE_CAPTURE_ATTEMPTS; attempt\+\+\)/);
  assert.match(hook, /cacheCaptureScenePath\(/);
  assert.match(hook, /cacheCaptureAttemptPath\(sceneCapturePath, attempt\)/);
  assert.match(hook, /selectPlaybackRetryScene\(bufferedScenes, focusSec, startAt\)/);
  assert.match(hook, /captureAnchorPath/);
  assert.match(hook, /subsync_prepare_cache_audio/);
  assert.match(hook, /if \(!retry\) throw error/);
  assert.match(hook, /cache-capture=verified attempt=/);
});
