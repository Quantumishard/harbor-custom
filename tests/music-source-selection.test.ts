import assert from "node:assert/strict";
import test from "node:test";
import { selectSourceCandidate } from "../src/lib/music/source-selection";
import type { MusicTrack } from "../src/lib/music/types";

function track(id: string, connectorId: string): MusicTrack {
  return {
    id,
    connectorId,
    title: "Camilla",
    artist: "Basshunter",
    artwork: "",
    durationSeconds: 195,
    durationLabel: "3:15",
  } as MusicTrack;
}

const youtube = { connectorId: "youtube", track: track("yt", "youtube") };
const spotify = { connectorId: "spotify", track: track("sp", "spotify") };
const soundcloud = { connectorId: "soundcloud", track: track("sc", "soundcloud") };

test("the preferred source outranks a remembered per-song pin", () => {
  const selected = selectSourceCandidate(
    [spotify, youtube],
    "youtube",
    { connectorId: "spotify", id: "sp" },
    "spotify",
  );
  assert.equal(selected?.connectorId, "youtube");
});

test("a pin still answers when the preferred source has no matching recording", () => {
  const selected = selectSourceCandidate(
    [spotify, soundcloud],
    "youtube",
    { connectorId: "soundcloud", id: "sc" },
    "spotify",
  );
  assert.equal(selected?.connectorId, "soundcloud");
});

test("a pin prefers the exact upload before another one from the same connector", () => {
  const other = { connectorId: "spotify", track: track("sp-other", "spotify") };
  const selected = selectSourceCandidate(
    [other, spotify],
    null,
    { connectorId: "spotify", id: "sp" },
    null,
  );
  assert.equal(selected?.track.id, "sp");
});

test("without a preference the playing source, then the first ranked candidate, answers", () => {
  assert.equal(
    selectSourceCandidate([spotify, youtube], null, null, "youtube")?.connectorId,
    "youtube",
  );
  assert.equal(
    selectSourceCandidate([spotify, youtube], null, null, "lastfm")?.connectorId,
    "spotify",
  );
  assert.equal(selectSourceCandidate([], "youtube", null, null), undefined);
});
