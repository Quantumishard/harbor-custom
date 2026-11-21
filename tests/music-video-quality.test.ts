import assert from "node:assert/strict";
import test from "node:test";
import {
  MUSIC_VIDEO_QUALITIES,
  clearMusicVideoSessionQuality,
  cycleMusicVideoQuality,
  defaultMusicVideoQuality,
  musicVideoMaxHeight,
  musicVideoQuality,
  setDefaultMusicVideoQuality,
  setMusicVideoSessionQuality,
} from "../src/lib/music/video-quality.ts";

test("a per-video choice never replaces the default", () => {
  setDefaultMusicVideoQuality("720");
  assert.equal(defaultMusicVideoQuality(), "720");
  assert.equal(musicVideoQuality(), "720");
  setMusicVideoSessionQuality("480");
  assert.equal(musicVideoQuality(), "480");
  assert.equal(defaultMusicVideoQuality(), "720");
  clearMusicVideoSessionQuality();
  assert.equal(musicVideoQuality(), "720");
  setDefaultMusicVideoQuality("auto");
  assert.equal(musicVideoMaxHeight(), null);
});

test("cycling walks the session quality through every option", () => {
  setDefaultMusicVideoQuality("auto");
  setMusicVideoSessionQuality("auto");
  for (const quality of MUSIC_VIDEO_QUALITIES.slice(1)) {
    cycleMusicVideoQuality();
    assert.equal(musicVideoQuality(), quality);
  }
  cycleMusicVideoQuality();
  assert.equal(musicVideoQuality(), "auto");
});
