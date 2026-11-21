import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness } from "./helpers/hook-harness.ts";
import { queueSessionIndex } from "../src/lib/queue-session.ts";

const queue = [
  { id: "before", meta: { id: "queued-before" }, episode: undefined },
  { id: "current", meta: { id: "current-show" }, episode: { season: 1, episode: 5 } },
  { id: "after", meta: { id: "queued-after" }, episode: undefined },
];

function setup(queueDrivesNav: boolean, currentIndex = 1, fromQueue = true) {
  const calls: string[] = [];
  let archived = false;
  let queueItems = [...queue];
  const hook = hookHarness("src/views/player/hooks/use-queue-nav.ts", "useQueueNav", {
    "@/lib/queue-session": { queueSessionIndex },
    "@/lib/queue": {
      useQueue: () => queueItems,
      queueIndexOf: () => currentIndex,
      queueArchive: (id: string, reason: string) => {
        if (archived) return false;
        archived = true;
        queueItems = queueItems.filter((item) => item.id !== id);
        calls.push(`archive:${id}:${reason}`);
        return true;
      },
    },
  });

  const current = queue[currentIndex];
  const params = {
    src: {
      meta: current.meta,
      episode: current.episode,
      queueItemId: fromQueue ? current.id : undefined,
    },
    adjacent: {
      prev: { season: 1, episode: 4 },
      next: { season: 1, episode: 6 },
    },
    canChangeEpisode: true,
    isLiveLike: false,
    queueDrivesNav,
    goToEpisode: (episode: { season: number; episode: number }) => {
      calls.push(`episode:${episode.season}:${episode.episode}`);
    },
    openPicker: (meta: { id: string }, _episode: unknown, options: { queueItemId?: string }) => {
      assert.equal(options.queueItemId, queue.find((item) => item.meta.id === meta.id)?.id);
      calls.push(`picker:${meta.id}`);
    },
  };
  const render = () => hook.render(params);
  const nav = render();

  return { hook, nav, calls, render };
}

test("Queue mode navigates to queued items instead of adjacent show episodes", () => {
  const { hook, nav, calls } = setup(true);
  try {
    assert.equal(nav.hasNextEpisodeNow, true);
    assert.equal(nav.hasPrevEpisodeNow, true);
    nav.playPrev();
    nav.playNext();
    assert.deepEqual(calls, [
      "picker:queued-before",
      "archive:current:skipped",
      "picker:queued-after",
    ]);
  } finally {
    hook.unmount();
  }
});

test("Pressing Next repeatedly archives and opens the successor only once", () => {
  const { hook, nav, calls } = setup(true);
  try {
    nav.playNext();
    nav.playNext();

    assert.deepEqual(calls, ["archive:current:skipped", "picker:queued-after"]);
  } finally {
    hook.unmount();
  }
});

test("A queue store rerender during Next does not fall back to adjacent episodes", () => {
  const { hook, nav, calls, render } = setup(true);
  try {
    nav.playNext();

    const transitioningNav = render();
    assert.equal(transitioningNav.hasNextEpisodeNow, false);
    assert.equal(transitioningNav.hasPrevEpisodeNow, false);

    transitioningNav.playNext();
    transitioningNav.playPrev();

    assert.deepEqual(calls, ["archive:current:skipped", "picker:queued-after"]);
  } finally {
    hook.unmount();
  }
});

test("A detached queue source never falls back while automatic advancement is pending", () => {
  const calls: string[] = [];
  const hook = hookHarness("src/views/player/hooks/use-queue-nav.ts", "useQueueNav", {
    "@/lib/queue-session": { queueSessionIndex },
    "@/lib/queue": {
      useQueue: () => [queue[2]],
      queueArchive: () => false,
    },
  });

  try {
    const nav = hook.render({
      src: {
        meta: queue[1].meta,
        episode: queue[1].episode,
        queueItemId: queue[1].id,
      },
      adjacent: {
        prev: { season: 1, episode: 4 },
        next: { season: 1, episode: 6 },
      },
      canChangeEpisode: true,
      isLiveLike: false,
      queueDrivesNav: true,
      goToEpisode: () => calls.push("episode"),
      openPicker: () => calls.push("picker"),
    });

    assert.equal(nav.hasNextEpisodeNow, false);
    assert.equal(nav.hasPrevEpisodeNow, false);

    nav.playNext();
    nav.playPrev();

    assert.deepEqual(calls, []);
  } finally {
    hook.unmount();
  }
});

test("Manually playing a queued title does not activate queue navigation", () => {
  const { hook, nav, calls } = setup(true, 1, false);
  try {
    nav.playNext();
    nav.playPrev();
    assert.deepEqual(calls, ["episode:1:6", "episode:1:4"]);
  } finally {
    hook.unmount();
  }
});

test("This show mode navigates to adjacent episodes instead of queued items", () => {
  const { hook, nav, calls } = setup(false);
  try {
    assert.equal(nav.hasNextEpisodeNow, true);
    assert.equal(nav.hasPrevEpisodeNow, true);
    nav.playNext();
    nav.playPrev();
    assert.deepEqual(calls, ["episode:1:6", "episode:1:4"]);
  } finally {
    hook.unmount();
  }
});

test("Queue mode does not fall back to the show at the end of the queue", () => {
  const { hook, nav, calls } = setup(true, 2);
  try {
    assert.equal(nav.hasNextEpisodeNow, false);
    nav.playNext();
    assert.deepEqual(calls, []);
  } finally {
    hook.unmount();
  }
});

test("Queue mode does not fall back to the show at the start of the queue", () => {
  const { hook, nav, calls } = setup(true, 0);
  try {
    assert.equal(nav.hasPrevEpisodeNow, false);
    nav.playPrev();
    assert.deepEqual(calls, []);
  } finally {
    hook.unmount();
  }
});

test("An empty queue preserves normal episode navigation even when Queue is enabled", () => {
  const calls: string[] = [];
  const hook = hookHarness("src/views/player/hooks/use-queue-nav.ts", "useQueueNav", {
    "@/lib/queue-session": { queueSessionIndex },
    "@/lib/queue": {
      useQueue: () => [],
      queueIndexOf: () => -1,
      queueArchive: () => false,
    },
  });

  try {
    const nav = hook.render({
      src: {
        meta: { id: "current-show" },
        episode: { season: 1, episode: 5 },
      },
      adjacent: {
        prev: { season: 1, episode: 4 },
        next: { season: 1, episode: 6 },
      },
      canChangeEpisode: true,
      isLiveLike: false,
      queueDrivesNav: true,
      goToEpisode: (episode: { season: number; episode: number }) => {
        calls.push(`episode:${episode.season}:${episode.episode}`);
      },
      openPicker: () => {
        calls.push("picker");
      },
    });

    assert.equal(nav.hasNextEpisodeNow, true);
    assert.equal(nav.hasPrevEpisodeNow, true);

    nav.playNext();
    nav.playPrev();

    assert.deepEqual(calls, ["episode:1:6", "episode:1:4"]);
  } finally {
    hook.unmount();
  }
});
