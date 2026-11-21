import { useEffect, useLayoutEffect, useRef } from "react";
import type { LiveScrobbleResolution } from "@/lib/identity/use-live-scrobble";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import { useSettings } from "@/lib/settings";
import type { PlayerSrc } from "@/lib/view";
import { resolvePmdbEpisodeTarget, resolvePmdbTarget } from "./ids";
import { usePublicMetaDb } from "./provider";
import { endPmdbPlayback, startPmdbPlayback, syncPmdbPlayback } from "./scrobble";
import { recordPendingResume, syncPendingResume } from "./pending-sync";
import type { PmdbTarget } from "./types";

type Snap = {
  status: string;
  positionSec: number;
  durationSec: number;
};

const STUB_MAX_SEC = 120;
const COMPLETION_RATIO = 0.9;
// Position snapshots are crash insurance only; PMDB asks for event-based
// saves (pause/stop/close), and each save counts against a 300/hour budget.
const MIN_SAVE_INTERVAL_MS = 60_000;
const SEEK_SAVE_DEBOUNCE_MS = 800;

export function usePublicMetaDbScrobble({
  src, snap, liveScrobble = { phase: "off", proof: null },
}: { src: PlayerSrc; snap: Snap; liveScrobble?: LiveScrobbleResolution }): void {
  const { isConnected } = usePublicMetaDb();
  const { settings } = useSettings();
  const verifiedTarget = liveScrobble.proof?.pmdbTarget ?? null;
  const enabled = isConnected && settings.publicmetadbScrobbleEnabled &&
    liveScrobble.phase !== "resolving" &&
    (!liveScrobble.proof || verifiedTarget != null);

  const targetRef = useRef<PmdbTarget | null>(null);
  const durationRef = useRef(0);
  const maxPosRef = useRef(0);
  const lastPosRef = useRef(0);
  const pageHiddenRef = useRef(false);
  const lastSaveTimeRef = useRef(0);
  const lastSavedPosRef = useRef(-1);
  const endedHandledRef = useRef(false);
  const playbackRef = useRef<ReturnType<typeof startPmdbPlayback> | null>(null);
  const completionRetryAt = useRef(0);
  const seekTrackRef = useRef({ pos: 0, at: 0 });
  const pendingSeekTimerRef = useRef<number | null>(null);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const statusRef = useRef(snap.status);
  statusRef.current = snap.status;

  const metaId = src.meta.id;
  const season = src.episode?.season;
  const episode = src.episode?.episode;
  const nativeProofKey = liveScrobble.phase === "resolving" ? "resolving"
    : liveScrobble.proof
      ? `${liveScrobble.proof.work.entryId}:${liveScrobble.proof.work.entryEpisode}:${JSON.stringify(verifiedTarget)}`
      : liveScrobble.phase;
  const key = `${metaId}|${season ?? ""}|${episode ?? ""}|${nativeProofKey}`;
  const lastKeyRef = useRef<string | null>(null);
  // Keep the outgoing owner's eligibility: a new proof may render in
  // `resolving` while the old verified session still needs a close save.
  const previousEligibilityRef = useRef({ key, enabled });

  const clearPendingSeek = () => {
    if (pendingSeekTimerRef.current != null) {
      window.clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
  };

  // Persist before sending so shutdown or a failed request cannot lose progress.
  // A real page unload leaves replay to the provider; player navigation can sync now.
  const saveOrWatched = (
    target: PmdbTarget | null,
    posSec: number,
    durSec: number,
    mode: "live" | "unload" = "live",
  ) => {
    const playback = playbackRef.current;
    if (!target || !playback || playback.watched || playback.marking || durSec < STUB_MAX_SEC)
      return;
    const clampedPos = Math.max(0, Math.min(durSec, Number.isFinite(posSec) ? posSec : 0));
    const ratio = durSec > 0 ? clampedPos / durSec : 0;
    if (ratio < 0.02) return;

    const posMs = Math.round(clampedPos * 1000);
    const durMs = Math.round(durSec * 1000);

    const now = Date.now();
    const watchedAt =
      playback.watchedAt ?? (ratio >= COMPLETION_RATIO ? new Date(now).toISOString() : undefined);
    const snapshot = { playbackId: playback.id, watchedAt };
    if (mode === "unload") {
      playback.watchedAt = watchedAt;
      recordPendingResume(target, posMs, durMs, now, snapshot);
      return;
    }

    if (watchedAt) {
      if (now < completionRetryAt.current) return;
      completionRetryAt.current = now + MIN_SAVE_INTERVAL_MS;
    }
    lastSaveTimeRef.current = now;
    lastSavedPosRef.current = clampedPos;
    void syncPendingResume(target, posMs, durMs, syncPmdbPlayback, snapshot);
  };

  // Track latest usable duration for the current key. Updated from the live
  // snapshot so interval/pause/pagehide handlers never read a stale closure.
  useEffect(() => {
    if (lastKeyRef.current !== key) return;
    if (snap.durationSec >= STUB_MAX_SEC) durationRef.current = snap.durationSec;
  }, [key, snap.durationSec]);

  // Resolve target whenever media identity changes. Cleanup flushes the
  // previous item from refs (still holding prev values at cleanup time).
  useEffect(() => {
    const prevKey = lastKeyRef.current;
    if (prevKey && prevKey !== key) {
      clearPendingSeek();
      if (previousEligibilityRef.current.key === prevKey &&
          previousEligibilityRef.current.enabled) {
        const t = targetRef.current;
        const d = durationRef.current;
        const p = lastPosRef.current;
        if (t && d >= STUB_MAX_SEC && p > 0) saveOrWatched(t, p, d);
      }
    }
    // A changed verified owner owns a new playback ID. Ordinary metadata
    // enrichment of the *same* proof must keep the completion guard intact.
    if (prevKey !== key || !playbackRef.current) {
      if (playbackRef.current) endPmdbPlayback(playbackRef.current);
      playbackRef.current = startPmdbPlayback();
      lastKeyRef.current = key;
      previousEligibilityRef.current = { key, enabled };
      durationRef.current = snap.durationSec >= STUB_MAX_SEC ? snap.durationSec : 0;
      maxPosRef.current = 0;
      lastPosRef.current = 0;
      endedHandledRef.current = false;
      completionRetryAt.current = 0;
      lastSaveTimeRef.current = 0;
      lastSavedPosRef.current = -1;
    }

    let cancelled = false;
    targetRef.current = null;

    void (async () => {
      let resolved: PmdbTarget | null = null;
      if (src.episode && liveScrobble.proof && !verifiedTarget) {
        // A verified native episode without a verified PMDB window must not
        // write a different season or title through catalog fallbacks.
        resolved = null;
      } else if (src.episode) {
        resolved = verifiedTarget ?? await resolvePmdbEpisodeTarget(
          metaId,
          {
            season: src.episode.season,
            episode: src.episode.episode,
            imdbSeason: src.episode.imdbSeason,
            imdbEpisode: src.episode.imdbEpisode,
            absoluteNumber: src.episode.absoluteNumber,
          },
          src.imdbId,
        ).catch(() => null);
      } else {
        const type = src.meta.type === "series" ? "series" : "movie";
        resolved = await resolvePmdbTarget(metaId, type).catch(() => null);
        if (!resolved && src.imdbId) {
          resolved = {
            id_type: "imdb",
            id_value: src.imdbId,
            media_type: type === "series" ? "tv" : "movie",
          };
        }
      }
      if (!cancelled) {
        targetRef.current = resolved;
        const live = getPlaybackPosition();
        lastPosRef.current = live;
        if (live > maxPosRef.current) maxPosRef.current = live;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    key,
    metaId,
    season,
    episode,
    src.episode?.imdbSeason,
    src.episode?.imdbEpisode,
    src.episode?.absoluteNumber,
    src.imdbId,
    src.meta.type,
    verifiedTarget,
    liveScrobble.proof,
  ]);

  // The target effect runs first on each change, so it can flush the outgoing
  // session with the previous eligibility before recording the incoming one.
  useEffect(() => {
    if (lastKeyRef.current === key)
      previousEligibilityRef.current = { key, enabled };
  }, [key, enabled]);

  // Active playback interval: periodically saves progress & detects seeks.
  useEffect(() => {
    if (!enabled) return;
    if (snap.status !== "playing" && snap.status !== "paused") return;

    seekTrackRef.current = { pos: getPlaybackPosition(), at: Date.now() };

    const intervalId = window.setInterval(() => {
      if (!enabledRef.current) return;
      const dur = durationRef.current || snap.durationSec;
      if (dur < STUB_MAX_SEC) return;
      const now = Date.now();
      const pos = getPlaybackPosition();
      lastPosRef.current = pos;
      if (pos > maxPosRef.current) maxPosRef.current = pos;

      const prev = seekTrackRef.current;
      const dPos = pos - prev.pos;
      const dT = Math.max(0.001, (now - prev.at) / 1000);
      seekTrackRef.current = { pos, at: now };

      const isSeek = Math.abs(dPos) > 4 && (dT < 1.5 || Math.abs(dPos / dT) > 2.5);
      if (isSeek) {
        clearPendingSeek();
        pendingSeekTimerRef.current = window.setTimeout(() => {
          pendingSeekTimerRef.current = null;
          if (!enabledRef.current) return;
          const live = getPlaybackPosition();
          lastPosRef.current = live;
          if (live > maxPosRef.current) maxPosRef.current = live;
          const t = targetRef.current;
          const d = durationRef.current;
          if (t && d >= STUB_MAX_SEC) saveOrWatched(t, live, d);
        }, SEEK_SAVE_DEBOUNCE_MS);
        return;
      }

      if (statusRef.current === "playing") {
        const timeSinceSave = now - lastSaveTimeRef.current;
        const posChange = Math.abs(pos - lastSavedPosRef.current);
        if (timeSinceSave >= MIN_SAVE_INTERVAL_MS && posChange >= 10) {
          const t = targetRef.current;
          if (t) saveOrWatched(t, pos, dur);
        }
      }
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
      clearPendingSeek();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, snap.status]);

  // Playback state transitions: paused saves, ended marks watched (or saves).
  // Uses maxPosRef so a natural end that resets position still completes.
  useEffect(() => {
    if (!enabled) return;
    const t = targetRef.current;
    if (!t) return;
    const dur = durationRef.current || snap.durationSec;
    if (dur < STUB_MAX_SEC) return;

    if (snap.status === "ended") {
      if (endedHandledRef.current) return;
      endedHandledRef.current = true;
      clearPendingSeek();
      const live = getPlaybackPosition();
      const best = Math.max(live, maxPosRef.current);
      saveOrWatched(t, best, dur);
      return;
    }

    if (snap.status === "paused") {
      clearPendingSeek();
      const live = getPlaybackPosition();
      if (live > maxPosRef.current) maxPosRef.current = live;
      lastPosRef.current = live;
      saveOrWatched(t, live, dur);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, snap.status]);

  // Page hide / app close. Registered once; reads refs so no stale closures.
  useEffect(() => {
    const onPageHide = () => {
      pageHiddenRef.current = true;
      if (!enabledRef.current) return;
      clearPendingSeek();
      const t = targetRef.current;
      const dur = durationRef.current;
      if (!t || dur < STUB_MAX_SEC) return;
      const live = getPlaybackPosition();
      const best = statusRef.current === "ended" ? Math.max(live, maxPosRef.current) : live;
      saveOrWatched(t, best, dur, "unload");
    };

    const onPageShow = () => {
      pageHiddenRef.current = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  // Capture the live clock before the bridge's passive cleanup resets it.
  useLayoutEffect(() => {
    return () => {
      if (enabledRef.current) {
        clearPendingSeek();
        const live = getPlaybackPosition();
        const best = statusRef.current === "ended" ? Math.max(live, maxPosRef.current) : live;
        saveOrWatched(
          targetRef.current,
          best,
          durationRef.current,
          pageHiddenRef.current ? "unload" : "live",
        );
      }
      if (playbackRef.current) endPmdbPlayback(playbackRef.current);
      playbackRef.current = null;
    };
  }, []);
}
