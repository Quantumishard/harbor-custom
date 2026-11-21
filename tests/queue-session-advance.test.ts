import assert from "node:assert/strict";
import test from "node:test";
import { flushPromises, hookHarness } from "./helpers/hook-harness.ts";
import { isNaturalEnd } from "../src/lib/player/playback-end.ts";
import { queueSessionIndex } from "../src/lib/queue-session.ts";

const first = { id: "a", meta: { id: "movie-a", type: "movie", name: "A" }, addedAt: 1 };
const second = { id: "b", meta: { id: "movie-b", type: "movie", name: "B" }, addedAt: 2 };

type TestQueueItem = typeof first & { episode?: { season: number; episode: number } };

function setup({
  archiveSucceeds = true,
  initialQueue = [first, second],
  completedSource = async () => null,
}: {
  archiveSucceeds?: boolean;
  initialQueue?: TestQueueItem[];
  completedSource?: () => Promise<unknown>;
} = {}) {
  const calls: unknown[] = [];
  let queue = [...initialQueue];
  const hook = hookHarness("src/views/player/hooks/use-queue-advance.ts", "useQueueAdvance", {
    "@/lib/queue-session": { queueSessionIndex },
    "@/lib/player/playback-clock": { getPlaybackPosition: () => 600 },
    "@/lib/player/playback-end": { isNaturalEnd },
    "@/lib/download/completed-episode-source": { completedEpisodeSource: completedSource },
    "@/lib/queue": {
      getSleepAtEnd: () => false,
      setSleepAtEnd: (value: boolean) => calls.push(["sleep", value]),
      queueIndexOf: (meta: { id: string }) => queue.findIndex((item) => item.meta.id === meta.id),
      queueArchive: (id: string, reason: string) => {
        calls.push(["archive", id, reason]);
        if (!archiveSucceeds) return false;
        queue = queue.filter((item) => item.id !== id);
        return true;
      },
      queueRemove: (id: string) => {
        calls.push(["remove", id]);
        queue = queue.filter((item) => item.id !== id);
      },
    },
  });
  const render = (src: Record<string, unknown>, instantPlay = false) =>
    hook.render({
      src,
      queue,
      snap: { status: "ended", durationSec: 600 },
      isLive: false,
      roomGuest: false,
      queueDrivesNav: true,
      instantPlay,
      startedNearEndRef: { current: false },
      openPicker: (...args: unknown[]) => calls.push(["picker", ...args]),
      closePlayer: () => calls.push(["close"]),
    });
  const removeFromQueue = (id: string) => {
    queue = queue.filter((item) => item.id !== id);
  };
  return { hook, calls, render, removeFromQueue };
}

test("Finishing unrelated playback neither starts nor consumes the queue", () => {
  const { hook, calls, render } = setup();
  try {
    render({ url: "other", meta: { id: "other" } });
    assert.deepEqual(calls, []);
  } finally {
    hook.unmount();
  }
});

test("Manual playback of a queued title does not consume or advance the queue", () => {
  const { hook, calls, render } = setup();
  try {
    render({ url: "manual", meta: first.meta });
    assert.deepEqual(calls, []);
  } finally {
    hook.unmount();
  }
});

for (const instantPlay of [false, true]) {
  test(`Queue advancement carries the next entry identity and respects instantPlay=${instantPlay}`, () => {
    const { hook, calls, render } = setup();
    try {
      const src = { url: "queued", meta: first.meta, queueItemId: first.id };
      render(src, instantPlay);
      render(src, instantPlay);
      assert.deepEqual(calls, [
        ["archive", first.id, "completed"],
        [
          "picker",
          second.meta,
          undefined,
          { autoPlay: instantPlay, resume: true, queueItemId: second.id },
        ],
      ]);
    } finally {
      hook.unmount();
    }
  });
}

test("The last queued item closes playback once instead of restarting the queue", () => {
  const { hook, calls, render } = setup();
  try {
    const src = { url: "last", meta: second.meta, queueItemId: second.id };
    render(src);
    render(src);
    assert.deepEqual(calls, [["archive", second.id, "completed"], ["close"]]);
  } finally {
    hook.unmount();
  }
});

test("Queue advancement aborts when the current item can no longer be archived", () => {
  const { hook, calls, render } = setup({ archiveSucceeds: false });

  try {
    const src = { url: "queued", meta: first.meta, queueItemId: first.id };
    render(src);
    render(src);

    assert.deepEqual(calls, [
      ["archive", first.id, "completed"],
      ["archive", first.id, "completed"],
    ]);
  } finally {
    hook.unmount();
  }
});

test("Pending advancement ignores a successor removed from the latest queue", async () => {
  let resolveLookup!: (value: null) => void;
  const lookup = new Promise<null>((resolve) => {
    resolveLookup = resolve;
  });
  const nextEpisode: TestQueueItem = {
    ...second,
    meta: { ...second.meta, type: "series" },
    episode: { season: 1, episode: 2 },
  };
  const { hook, calls, render, removeFromQueue } = setup({
    initialQueue: [first, nextEpisode],
    completedSource: () => lookup,
  });

  try {
    const src = { url: "queued", meta: first.meta, queueItemId: first.id };
    render(src);
    removeFromQueue(nextEpisode.id);
    render(src);

    resolveLookup(null);
    await flushPromises();

    assert.deepEqual(calls, [["archive", first.id, "completed"]]);
  } finally {
    hook.unmount();
  }
});
