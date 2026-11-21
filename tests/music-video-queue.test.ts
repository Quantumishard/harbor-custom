import assert from "node:assert/strict";
import test from "node:test";
import { musicVideoPlayback, musicWatchQueue } from "../src/lib/music/video-queue.ts";
import type { MusicTrack } from "../src/lib/music/types.ts";

const track = (id: string, title: string, artist: string, connectorId = "youtube"): MusicTrack =>
  ({
    id,
    connectorId,
    title,
    artist,
    artwork: "",
    durationSeconds: 180,
    durationLabel: "3:00",
  }) as MusicTrack;

test("the official video of the playing song keeps the live queue", () => {
  const live = {
    current: track("smart-audio", "Smart", "LE SSERAFIM"),
    queue: [track("smart-audio", "Smart", "LE SSERAFIM"), track("b", "ELEVEN", "IVE")],
    queueIndex: 0,
  };
  const picked = track("smart-mv", "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV", "HYBE LABELS");
  assert.deepEqual(
    musicWatchQueue(picked, [track("x", "Unrelated video", "HYBE LABELS")], live).map(
      (item) => item.id,
    ),
    ["smart-audio", "b"],
  );
});

test("a remix from another act does not inherit the queue", () => {
  const live = {
    current: track("smart", "Smart", "LE SSERAFIM"),
    queue: [track("smart", "Smart", "LE SSERAFIM"), track("b", "ELEVEN", "IVE")],
    queueIndex: 0,
  };
  const picked = track("remix", "Smart (Remix)", "DJ Someone");
  assert.deepEqual(
    musicWatchQueue(picked, [track("offered", "Offered", "Other")], live).map((item) => item.id),
    ["offered"],
  );
});

test("a different song keeps the list it was opened from", () => {
  const live = {
    current: track("smart", "Smart", "LE SSERAFIM"),
    queue: [track("smart", "Smart", "LE SSERAFIM"), track("b", "ELEVEN", "IVE")],
    queueIndex: 0,
  };
  assert.deepEqual(
    musicWatchQueue(
      track("eleven", "ELEVEN", "IVE"),
      [track("offered", "Offered", "Other")],
      live,
    ).map((item) => item.id),
    ["offered"],
  );
});

test("a queue with nothing after the song hands over the opened list", () => {
  const live = {
    current: track("celebration", "CELEBRATION", "LE SSERAFIM"),
    queue: [track("celebration", "CELEBRATION", "LE SSERAFIM")],
    queueIndex: 0,
  };
  const offered = [track("mv", "LE SSERAFIM 'CELEBRATION' Official MV", "HYBE LABELS")];
  assert.deepEqual(
    musicWatchQueue(offered[0], offered, live).map((item) => item.id),
    ["mv"],
  );
});

test("the last song of a longer queue also hands over the opened list", () => {
  const live = {
    current: track("b", "ELEVEN", "IVE"),
    queue: [track("a", "Smart", "LE SSERAFIM"), track("b", "ELEVEN", "IVE")],
    queueIndex: 1,
  };
  assert.deepEqual(
    musicWatchQueue(track("b", "ELEVEN", "IVE"), [track("offered", "Offered", "Other")], live).map(
      (item) => item.id,
    ),
    ["offered"],
  );
});

test("an empty live queue falls back to the offered list", () => {
  const live = { current: null, queue: [], queueIndex: -1 };
  assert.deepEqual(
    musicWatchQueue(
      track("mv", "Smart", "LE SSERAFIM"),
      [track("offered", "Offered", "Other")],
      live,
    ).map((item) => item.id),
    ["offered"],
  );
});

test("the result never aliases the live queue snapshot", () => {
  const queue = [track("smart", "Smart", "LE SSERAFIM"), track("b", "ELEVEN", "IVE")];
  const result = musicWatchQueue(queue[0], [], { current: queue[0], queue, queueIndex: 0 });
  assert.notEqual(result, queue);
});

test("playing a video of the current song keeps the song name", () => {
  const playing = track("gnarly-audio", "Gnarly", "KATSEYE");
  const video = track("gnarly-mv", "KATSEYE (캣츠아이) 'Gnarly' Official MV", "KATSEYE");
  assert.deepEqual(musicVideoPlayback(video, { current: playing }), {
    ...video,
    title: "Gnarly",
    artist: "KATSEYE",
  });
});

test("a video that is not the current song keeps its own title", () => {
  const playing = track("smart", "Smart", "LE SSERAFIM");
  const other = track("eleven-mv", "ELEVEN", "IVE");
  assert.deepEqual(musicVideoPlayback(other, { current: playing }), other);
});

test("a video opened on its own still plays under the song name", () => {
  const video = track("gnarly-mv", "KATSEYE (캣츠아이) 'Gnarly' Official MV", "KATSEYE");
  assert.equal(musicVideoPlayback(video, { current: null }).title, "Gnarly");
  // A bracket that carries meaning in Latin script stays.
  const part = track("part", "Song (Part 2) Official Video", "The Act");
  assert.equal(musicVideoPlayback(part, { current: null }).title, "Song (Part 2)");
});
