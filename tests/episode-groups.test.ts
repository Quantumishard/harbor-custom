import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness } from "./helpers/hook-harness.ts";
import {
  groupEpisodes,
  hasNumberedEpisodes,
  episodeNumber,
  NO_SEASON,
  type CinemetaVideo,
} from "../src/views/detail/episode-groups.ts";

const v = (
  season: number | null,
  episode: number | null,
  name: string,
  released?: string,
): CinemetaVideo => ({
  season: season ?? undefined,
  episode: episode ?? undefined,
  name,
  released,
});

const seasons = (groups: ReturnType<typeof groupEpisodes>) => groups.map((g) => g.seasonNumber);
const names = (groups: ReturnType<typeof groupEpisodes>, season: number) =>
  groups.find((g) => g.seasonNumber === season)?.episodes.map((e) => e.name);

test("seasons keep their own order and the episodes inside them are sorted", () => {
  const groups = groupEpisodes([v(2, 2, "b"), v(1, 2, "d"), v(2, 1, "a"), v(1, 1, "c")]);
  assert.deepEqual(seasons(groups), [1, 2]);
  assert.deepEqual(names(groups, 1), ["c", "d"]);
  assert.deepEqual(names(groups, 2), ["a", "b"]);
});

test("a provider's unnumbered episodes get their own group after the seasons", () => {
  // The real shape: season 2 is numbered, and the bonus episodes carry no season at all.
  const groups = groupEpisodes([
    v(2, 1, "Episode 1"),
    v(2, 2, "Episode 2"),
    v(null, 1, "Episode 1 Bonus"),
    v(null, 2, "Episode 2 Bonus"),
  ]);
  assert.deepEqual(seasons(groups), [2, NO_SEASON]);
  assert.deepEqual(names(groups, NO_SEASON), ["Episode 1 Bonus", "Episode 2 Bonus"]);
  // They are a group of their own, not a second copy of season 2.
  assert.deepEqual(names(groups, 2), ["Episode 1", "Episode 2"]);
});

test("a provider that numbers nothing gives one group, as it always did", () => {
  const groups = groupEpisodes([v(null, 1, "One"), v(null, 2, "Two")]);
  assert.deepEqual(seasons(groups), [NO_SEASON]);
  assert.deepEqual(names(groups, NO_SEASON), ["One", "Two"]);
});

test("the unnumbered group keeps the provider's order, because a row is addressed by position", () => {
  // These have no numbers, so the position in this list is the only address a row has. Sorting it
  // would make that position name a different episode than the one the player is asked for.
  const groups = groupEpisodes([
    v(null, 1, "first", "2024-05-01"),
    v(null, 2, "second", "2024-01-01"),
  ]);
  assert.deepEqual(names(groups, NO_SEASON), ["first", "second"]);
});

test("nothing in gives nothing out", () => {
  assert.deepEqual(groupEpisodes([]), []);
});

test("an episode with a season but no number still lands in the unnumbered group", () => {
  // It cannot be addressed by number either way, so it belongs with the episodes that cannot be.
  const groups = groupEpisodes([v(2, 1, "Numbered"), v(2, null, "Unnumbered")]);
  assert.deepEqual(seasons(groups), [2, NO_SEASON]);
  assert.deepEqual(names(groups, NO_SEASON), ["Unnumbered"]);
});

test("number-only Cinemeta series expose every episode without a TMDB match", () => {
  const titles = ["Manhattan", "San Francisco", "Rome", "London", "Paris", "New Orleans"];
  const videos = titles.map((name, index) => ({
    id: `tt5027982:1:${index + 1}`,
    name,
    season: 1,
    number: index + 1,
  }));
  assert.equal(hasNumberedEpisodes(videos), true);
  const groups = groupEpisodes([...videos].reverse());
  assert.deepEqual(seasons(groups), [1]);
  assert.deepEqual(names(groups, 1), titles);
  assert.deepEqual(
    groups[0].episodes.map((episode) => episodeNumber(episode, 0)),
    [1, 2, 3, 4, 5, 6],
  );
});

test("mixed numbering formats and specials remain visible without altering provider records", () => {
  const videos: CinemetaVideo[] = [
    { season: 2, episode: 2, name: "Standard" },
    { season: 2, number: 1, name: "Alternate" },
    { season: 0, number: 1, name: "Special" },
    { season: 2, episode: 3, number: 99, name: "Explicit wins" },
  ];
  const original = JSON.stringify(videos);
  assert.equal(hasNumberedEpisodes(videos), true);
  assert.equal(hasNumberedEpisodes([videos[2]]), true);
  const groups = groupEpisodes(videos);
  assert.deepEqual(seasons(groups), [0, 2]);
  assert.deepEqual(names(groups, 2), ["Alternate", "Standard", "Explicit wins"]);
  assert.equal(episodeNumber(videos[3], 0), 3);
  assert.equal(JSON.stringify(videos), original);
});

test("empty or unnumbered metadata does not invent an episode list", () => {
  assert.equal(hasNumberedEpisodes(undefined), false);
  assert.equal(hasNumberedEpisodes([]), false);
  assert.equal(hasNumberedEpisodes([{ season: 1, name: "Unnumbered" }]), false);
  assert.equal(hasNumberedEpisodes([{ number: 1, name: "No season" }]), false);
  assert.equal(hasNumberedEpisodes([{ season: 1, episode: 1 }]), true);
});

test("the per-season fallback renders number-only and standard episodes in order", () => {
  const jsx = (type: unknown, props: any, key: unknown) => ({ type, props, key });
  const h = hookHarness(
    "src/views/detail/series-episodes/cinemeta-fallback.tsx",
    "CinemetaFallback",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "../episode-groups": { episodeNumber, groupEpisodes },
      "@/lib/i18n": { useT: () => (text: string) => text },
      "../cinemeta-episodes": { CinemetaEpisodeRow: "episode-row" },
    },
  );
  const tree = h.render({
    meta: { id: "another-series", type: "series", name: "Another series" },
    season: 2,
    videos: [
      { season: 2, number: 3, name: "Third" },
      { season: 1, number: 1, name: "Other season" },
      { season: 2, episode: 1, name: "First" },
      { season: 2, number: 2, name: "Second" },
      { season: 2, name: "Unnumbered" },
    ],
    imdbRatings: new Map([["2:2", 8.5]]),
  });
  assert.deepEqual(
    tree.props.children.map((child: any) => child.props.ep.name),
    ["First", "Second", "Third"],
  );
  assert.equal(tree.props.children[1].props.imdbRating, 8.5);
  assert.deepEqual(
    tree.props.children.map((child: any) => child.key),
    ["2-1", "2-2", "2-3"],
  );
});
