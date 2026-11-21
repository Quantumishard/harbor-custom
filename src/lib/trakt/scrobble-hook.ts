import { useCallback, useEffect, useRef } from "react";
import type { LiveScrobbleResolution } from "@/lib/identity/use-live-scrobble";
import { useTrakt } from "./provider";
import { TRAKT_API_BASE, TRAKT_API_VERSION, TRAKT_CLIENT_ID } from "./config";
import { getSession } from "./session";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PlayerSrc } from "@/lib/view";

type Snap = {
  status: string;
  positionSec: number;
  durationSec: number;
};

type LastAction = "start" | "pause" | "stop" | null;

const STUB_MAX_SEC = 150;
// Keep pause scrobbles (resumable on other devices) up to where Harbor's own
// CW drops the card (CW_FINISHED_RATIO); only beyond that report stop/watched.
const WATCHED_MARK_PCT = 90;

export function useTraktScrobble({
  src, snap, liveScrobble = { phase: "off", proof: null },
}: { src: PlayerSrc; snap: Snap; liveScrobble?: LiveScrobbleResolution }): void {
  const { isConnected: providerConnected, resolveTarget, scrobble } = useTrakt();
  const verifiedTarget = liveScrobble.proof?.traktTarget ?? undefined;
  // If the native work is verified but its catalog episode coordinates are
  // not, never fall back to a guessed franchise episode for this provider.
  const isConnected = providerConnected && liveScrobble.phase !== "resolving" &&
    (!liveScrobble.proof || verifiedTarget != null);
  const scrobbleVerified = useCallback((...args: Parameters<typeof scrobble>) =>
    scrobble(args[0], { ...args[1], verifiedTarget: args[1].verifiedTarget ?? verifiedTarget }),
  [scrobble, verifiedTarget]);
  const lastActionRef = useRef<LastAction>(null);
  const lastKeyRef = useRef<string | null>(null);
  const prevIdentityRef = useRef({ metaId: src.meta.id, episode: src.episode, verifiedTarget });
  const progressRef = useRef(0);
  const loadResetSeenRef = useRef(true);

  const metaId = src.meta.id;
  const season = src.episode?.season;
  const episode = src.episode?.episode;
  const episodeKey = `${metaId}|${season ?? ""}|${episode ?? ""}`;
  // Re-verification can change the native owner without changing the visible
  // episode. That starts a different tracker session, not a continuation of
  // the old target. Include the pending state so A is closed before B resolves.
  const proofKey = liveScrobble.phase === "resolving" ? "resolving"
    : liveScrobble.proof
      ? [liveScrobble.proof.work.entryId, liveScrobble.proof.work.entryEpisode,
          JSON.stringify(liveScrobble.proof.traktTarget)].join(":")
      : liveScrobble.phase;
  const key = `${episodeKey}|${proofKey}`;
  const prevEpisodeKeyRef = useRef(episodeKey);

  const stopArgsRef = useRef({ metaId, episode: src.episode, snap, verifiedTarget });
  stopArgsRef.current = { metaId, episode: src.episode, snap, verifiedTarget };

  useEffect(() => {
    if (!isConnected) return;
    const target = verifiedTarget ?? resolveTarget(metaId, src.episode);
    if (!target) return;
    const onPageHide = () => {
      const a = stopArgsRef.current;
      if (a.snap.durationSec <= 0) return;
      if (lastActionRef.current !== "start" && lastActionRef.current !== "pause") return;
      const live = (getPlaybackPosition() / a.snap.durationSec) * 100;
      const progress = Math.min(100, Math.max(0, progressRef.current, live));
      const action = progress >= WATCHED_MARK_PCT ? "stop" : "pause";
      sendBeacon(target, action === "stop" ? 100 : progress, action);
      // Beacon is fire-and-forget and may drop on exit, so also run the
      // confirmed stop to clear Trakt's "Now Playing" and write history.
      if (action === "stop") void scrobbleVerified("stop", { metaId, episode: a.episode, progress: 100, verifiedTarget: a.verifiedTarget });
      lastActionRef.current = action;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [isConnected, resolveTarget, scrobbleVerified, metaId, src.episode, verifiedTarget]);

  useEffect(() => {
    if (lastKeyRef.current && lastKeyRef.current !== key) {
      const prev = prevIdentityRef.current;
      const prevProgress = progressRef.current;
      if (lastActionRef.current !== "stop") {
        // Call the provider with the *outgoing* proof. The current render's
        // scrobbleVerified callback may already point to the incoming owner.
        if (prevProgress >= WATCHED_MARK_PCT) {
          void scrobble("stop", { metaId: prev.metaId, episode: prev.episode, verifiedTarget: prev.verifiedTarget, progress: 100 });
        } else if (prevProgress > 0 || lastActionRef.current === "start" ||
                   lastActionRef.current === "pause") {
          void scrobble("pause", { metaId: prev.metaId, episode: prev.episode, verifiedTarget: prev.verifiedTarget, progress: prevProgress });
        }
      }
      lastActionRef.current = null;
      progressRef.current = 0;
      // Same displayed episode, new proof: no player loading reset is expected.
      // An actual episode switch must still wait for its own loading transition.
      loadResetSeenRef.current = prevEpisodeKeyRef.current === episodeKey;
    }
    lastKeyRef.current = key;
    prevEpisodeKeyRef.current = episodeKey;
    prevIdentityRef.current = { metaId, episode: src.episode, verifiedTarget };
  }, [key, episodeKey, metaId, src.episode, scrobble]);

  useEffect(() => {
    if (!isConnected) return;
    const target = verifiedTarget ?? resolveTarget(metaId, src.episode);
    if (!target) return;
    if (snap.status === "ended") {
      if (
        snap.durationSec >= STUB_MAX_SEC &&
        (lastActionRef.current === "start" || lastActionRef.current === "pause")
      ) {
        const endPct =
          snap.durationSec > 0
            ? Math.min(
                100,
                Math.max(0, progressRef.current, (getPlaybackPosition() / snap.durationSec) * 100),
              )
            : 100;
        scrobbleVerified("stop", { metaId, episode: src.episode, progress: endPct });
        lastActionRef.current = "stop";
      }
      return;
    }
    if (!loadResetSeenRef.current) {
      if (snap.status === "loading" || snap.durationSec <= 0) loadResetSeenRef.current = true;
      return;
    }
    if (snap.durationSec <= 0) return;
    if (snap.durationSec < STUB_MAX_SEC) return;
    const progress = Math.min(100, Math.max(0, (getPlaybackPosition() / snap.durationSec) * 100));
    if (progress > progressRef.current) progressRef.current = progress;

    if (lastActionRef.current === "stop") return;

    if (snap.status === "playing" && lastActionRef.current !== "start") {
      scrobbleVerified("start", { metaId, episode: src.episode, progress });
      lastActionRef.current = "start";
    } else if (snap.status === "paused" && lastActionRef.current === "start") {
      scrobbleVerified("pause", { metaId, episode: src.episode, progress });
      lastActionRef.current = "pause";
    }
  }, [isConnected, resolveTarget, scrobbleVerified, metaId, src.episode, snap.status, snap.durationSec, verifiedTarget]);

  const seekTrackRef = useRef({ pos: 0, at: 0, lastResyncAt: 0 });
  useEffect(() => {
    if (!isConnected) return;
    if (snap.durationSec <= 0) return;
    if (snap.durationSec < STUB_MAX_SEC) return;
    if (lastActionRef.current !== "start") {
      seekTrackRef.current = { pos: getPlaybackPosition(), at: Date.now(), lastResyncAt: 0 };
      return;
    }
    const id = window.setInterval(() => {
      if (lastActionRef.current !== "start") return;
      const now = Date.now();
      const ref = seekTrackRef.current;
      const pos = getPlaybackPosition();
      if (snap.durationSec > 0) {
        const pct = (pos / snap.durationSec) * 100;
        if (pct > progressRef.current) progressRef.current = pct;
      }
      const dPos = pos - ref.pos;
      const dT = (now - ref.at) / 1000;
      ref.pos = pos;
      ref.at = now;
      const isSeek = Math.abs(dPos) > 8 && (dT < 1.5 || Math.abs(dPos / Math.max(0.001, dT)) > 4);
      if (!isSeek) return;
      if (now - ref.lastResyncAt < 30000) return;
      ref.lastResyncAt = now;
      const progress = Math.min(100, Math.max(0, (pos / snap.durationSec) * 100));
      scrobbleVerified("start", { metaId, episode: src.episode, progress });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isConnected, scrobbleVerified, metaId, src.episode, snap.status, snap.durationSec]);

  useEffect(() => {
    return () => {
      if (lastActionRef.current !== "start" && lastActionRef.current !== "pause") return;
      const a = stopArgsRef.current;
      if (a.snap.durationSec > 0) {
        const live = (getPlaybackPosition() / a.snap.durationSec) * 100;
        const progress = Math.min(100, Math.max(progressRef.current, live));
        const action = progress >= WATCHED_MARK_PCT ? "stop" : "pause";
        scrobbleVerified(action, {
          metaId: a.metaId,
          episode: a.episode,
          verifiedTarget: a.verifiedTarget,
          progress: action === "stop" ? 100 : progress,
        });
        lastActionRef.current = action;
      } else {
        lastActionRef.current = "pause";
      }
    };
  }, [scrobble]);
}

function sendBeacon(
  target: ReturnType<NonNullable<ReturnType<typeof useTrakt>["resolveTarget"]>> & object,
  progress: number,
  action: "stop" | "pause",
): void {
  const session = getSession();
  if (!session) return;
  if (target.kind === "show") return;
  const clamped = Math.max(0, Math.min(100, Number(progress.toFixed(2))));
  let body: object;
  if (target.kind === "movie") {
    body = { movie: { ids: target.ids }, progress: clamped };
  } else if (target.episodeIds && Object.keys(target.episodeIds).length > 0) {
    body =
      Object.keys(target.show.ids).length > 0
        ? { show: { ids: target.show.ids }, episode: { ids: target.episodeIds }, progress: clamped }
        : { episode: { ids: target.episodeIds }, progress: clamped };
  } else {
    body = {
      show: { ids: target.show.ids },
      episode: { season: target.season, number: target.number },
      progress: clamped,
    };
  }
  const url = `${TRAKT_API_BASE}/scrobble/${action}`;
  try {
    void fetch(url, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "trakt-api-version": TRAKT_API_VERSION,
        "trakt-api-key": TRAKT_CLIENT_ID,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* noop */
  }
}
