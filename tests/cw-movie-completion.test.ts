import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCompletedMovies, movieCompletionAliasWarmRows } from "../src/lib/cw-movie-completion.ts";
import { isCwMember, type LibraryItem } from "../src/lib/stremio.ts";

const IMDb = "tt20969586";
const TMDB = "tmdb:movie:986056";
const FINISHED = "2026-01-10T12:00:00Z";
const EARLIER = "2025-12-01T12:00:00Z";
const LATER = "2026-02-11T12:00:00Z";

function record(
  id: string, when: string,
  options: { done?: boolean; local?: boolean; name?: string; altIds?: string[]; offset?: number } = {},
): LibraryItem {
  return {
    _id: id, type: "movie", name: options.name ?? "Thunderbolts*",
    removed: false, temp: false, _ctime: when, _mtime: when,
    altIds: options.altIds, local: options.local,
    state: {
      timeOffset: options.offset ?? (options.done ? 7_598_340 : 600_000),
      duration: 7_609_977, flaggedWatched: options.done ? 1 : 0,
      lastWatched: when,
    },
  };
}

test("Thunderbolts: a completed IMDb movie hides older unfinished local TMDB playback", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const oldLocal = record(TMDB, EARLIER, { local: true });
  const result = reconcileCompletedMovies([completed, oldLocal]);
  assert.deepEqual(result.suppressed, [oldLocal]);
  assert.deepEqual(result.rows, [completed]);
  assert.equal(completed.state?.flaggedWatched, 1, "completion source remains intact");
  assert.equal(oldLocal.state?.timeOffset, 600_000, "old local checkpoint is never deleted");
});

test("same-id completed movie also suppresses old incomplete record", () => {
  const complete = record(IMDb, FINISHED, { done: true });
  const incomplete = record(IMDb, EARLIER);
  assert.deepEqual(reconcileCompletedMovies([incomplete, complete]).suppressed, [incomplete]);
});

test("a genuinely later rewatch survives completion, even under a different verified alias", () => {
  const completed = record(IMDb, FINISHED, { done: true });
  const replay = record(TMDB, LATER, { local: true, altIds: [IMDb], offset: 120_000 });
  const result = reconcileCompletedMovies([completed, replay]);
  assert.deepEqual(result.suppressed, []);
  assert.ok(result.rows.includes(replay));
});

test("completion by 90% ratio counts without flaggedWatched", () => {
  const completed = record(IMDb, FINISHED, { offset: 7_000_000, altIds: [TMDB] });
  const older = record(TMDB, EARLIER);
  assert.deepEqual(reconcileCompletedMovies([completed, older]).suppressed, [older]);
});

test("never merge same-title movies without a verified alias", () => {
  const complete = record(IMDb, FINISHED, { done: true });
  const otherMovie = record(TMDB, EARLIER);
  assert.deepEqual(reconcileCompletedMovies([complete, otherMovie]).suppressed, []);
  assert.deepEqual(movieCompletionAliasWarmRows([complete, otherMovie]), [complete, otherMovie],
    "matching title may request a mapping, not prove identity");
});

test("conflicting IMDb aliases fail open even when bridged by TMDB", () => {
  const complete = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const conflict = record(TMDB, EARLIER, { altIds: ["tt1111111"] });
  assert.deepEqual(reconcileCompletedMovies([complete, conflict]).suppressed, []);
});

test("source availability determines whether a completion can suppress another source", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const local = record(TMDB, EARLIER, { local: true, altIds: [IMDb] });
  assert.deepEqual(reconcileCompletedMovies([local]).suppressed, [],
    "when library is disabled/hidden, no completion evidence was supplied");
  assert.deepEqual(reconcileCompletedMovies([completed, local]).suppressed, [local]);
});

test("older completed movie does not suppress a newer in-progress external checkpoint", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const active = { ...record(TMDB, LATER, { altIds: [IMDb] }), external: "simkl" as const };
  assert.deepEqual(reconcileCompletedMovies([completed, active]).suppressed, []);
});

test("unknown movie completion timestamp fails open", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  completed.state!.lastWatched = "";
  completed._mtime = "";
  const local = record(TMDB, EARLIER);
  assert.deepEqual(reconcileCompletedMovies([completed, local]).suppressed, []);
});

test("series, anime, and unrecognized movie IDs aren't reconciled", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const series = { ...record(TMDB, EARLIER), type: "series" };
  const anime = { ...record(TMDB, EARLIER), isAnime: true };
  const unsupported = record("local:movie:abc", EARLIER);
  assert.deepEqual(reconcileCompletedMovies([completed, series, anime, unsupported]).suppressed, []);
});

test("pipeline: completion reconciliation must run before isCwMember removes finished evidence", () => {
  const completed = record(IMDb, FINISHED, { done: true, altIds: [TMDB] });
  const stale = record(TMDB, EARLIER, { local: true });
  const originalOrder = [completed, stale].filter(isCwMember);
  assert.deepEqual(originalOrder, [stale], "old filter-first pipeline loses the completion record");
  const correctedOrder = reconcileCompletedMovies([completed, stale]).rows.filter(isCwMember);
  assert.deepEqual(correctedOrder, [], "completed and older progress are both absent from CW");
});
