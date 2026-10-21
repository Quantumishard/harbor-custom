import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness } from "./helpers/hook-harness.ts";

test("Next prefers the current show's next episode over a queued one", () => {
  const calls: string[] = [];
  const hook = hookHarness(
    "src/views/player/hooks/use-queue-nav.ts",
    "useQueueNav",
    {
      "@/lib/queue": {
        useQueue: () => [{ meta: { id: "tt1" }, episode: { season: 1, episode: 2 } }],
        queueIndexOf: () => 0,
      },
    },
  );
  const { playNext } = hook.render({
    src: { meta: { id: "tt1" }, episode: { season: 1, episode: 1 } },
    adjacent: { prev: null, next: { season: 1, episode: 2 } },
    canChangeEpisode: true,
    isLiveLike: false,
    queueDrivesNav: true,
    goToEpisode: (episode: unknown) => calls.push(`episode:${JSON.stringify(episode)}`),
    openPicker: () => calls.push("picker"),
  });
  playNext();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^episode:/);
  hook.unmount();
});
