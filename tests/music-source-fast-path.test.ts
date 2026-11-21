import assert from "node:assert/strict";
import test from "node:test";
import { startsFromPreferredSource } from "../src/lib/music/source-choice";
import type { MusicTrack } from "../src/lib/music/types";

function track(patch: Partial<MusicTrack>): MusicTrack {
  return {
    id: "a1",
    connectorId: "youtube",
    title: "Camilla",
    artist: "Basshunter",
    artwork: "",
    durationSeconds: 195,
    durationLabel: "3:15",
    ...patch,
  } as MusicTrack;
}

test("a song already carried by the preferred source starts without a cross-source search", () => {
  assert.equal(startsFromPreferredSource(track({ connectorId: "youtube" }), "youtube"), true);
  assert.equal(startsFromPreferredSource(track({ connectorId: "spotify" }), "spotify"), true);
});

test("a song from another source still needs the lookup", () => {
  assert.equal(startsFromPreferredSource(track({ connectorId: "spotify" }), "youtube"), false);
  assert.equal(startsFromPreferredSource(track({ connectorId: "soundcloud" }), "youtube"), false);
});

test("catalog and video picks keep the existing resolution path", () => {
  assert.equal(startsFromPreferredSource(track({ connectorId: "catalog" }), "catalog"), false);
  assert.equal(startsFromPreferredSource(track({ connectorId: undefined }), "youtube"), false);
  assert.equal(
    startsFromPreferredSource(track({ connectorId: "youtube", mediaKind: "video" }), "youtube"),
    false,
  );
});

test("a stored playback url is handled before the preference lookup", () => {
  assert.equal(
    startsFromPreferredSource(
      track({ connectorId: "youtube", playbackUrl: "https://example.test/a.m4a" }),
      "youtube",
    ),
    false,
  );
});
