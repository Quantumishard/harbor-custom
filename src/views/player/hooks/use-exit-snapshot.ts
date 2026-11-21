import { useCallback, useEffect, useRef, type RefObject } from "react";
import { captureFrame, captureMpvFrame, saveSnapshot } from "@/lib/snapshots";
import { useSettings } from "@/lib/settings";
import { trickplayGet } from "@/lib/trickplay";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PlayerStatus } from "@/lib/player/bridge";
import type { PlayerSrc } from "@/lib/view";
import { cloudWriteId } from "@/lib/stremio";

const CACHE_MS = 60000;
const REFRESH_MS = 300000;
const WARM_MS = 4000;
const EXIT_GRAB_MS = 700;
const GRAB_FULL_MS = 3500;
const END_RATIO = 0.92;

type Cached = { img: string; id: string; aliases: string[] };

function mediaKey(src: PlayerSrc): string {
  return JSON.stringify([src.meta.id, src.url, src.episode?.season, src.episode?.episode]);
}

function snapshotId(src: PlayerSrc, resolved: string | null, verified: boolean): string | null {
  const id = src.meta.id ?? "";
  if (!id || id.startsWith("iptv:")) return null;
  return cloudWriteId(id, src.imdbId ?? resolved, verified) || id;
}

function persist(cached: Cached | null): void {
  if (!cached) return;
  saveSnapshot(cached.id, cached.img, cached.aliases);
}

function nearEnd(cur: number, dur: number, ended: boolean): boolean {
  return ended || (dur > 0 && cur >= dur * END_RATIO);
}

export function useExitSnapshot(params: {
  src: PlayerSrc;
  engine: "html5" | "mpv";
  status: PlayerStatus;
  durationSec: number;
  videoMountRef: RefObject<HTMLDivElement | null>;
  resolvedImdbId: string | null;
  resolvedImdbVerified: boolean;
  seekPreviewEnabled: boolean;
}) {
  const {
    src,
    engine,
    status,
    durationSec,
    videoMountRef,
    resolvedImdbId,
    resolvedImdbVerified,
    seekPreviewEnabled,
  } = params;
  const { settings } = useSettings();
  const fullQuality = settings.cwSnapshotFullQuality;
  const snapshotsOff = settings.cwSnapshotRetentionDays === 0;
  const sourceKey = mediaKey(src);
  const latest = useRef({
    src,
    engine,
    durationSec,
    resolvedImdbId,
    resolvedImdbVerified,
    seekPreviewEnabled,
    fullQuality,
    snapshotsOff,
    sourceKey,
  });
  latest.current = {
    src,
    engine,
    durationSec,
    resolvedImdbId,
    resolvedImdbVerified,
    seekPreviewEnabled,
    fullQuality,
    snapshotsOff,
    sourceKey,
  };
  const lastGoodRef = useRef<Cached | null>(null);
  const lastGrabAtRef = useRef(0);
  const capturedKeyRef = useRef<string | null>(null);
  const previousSource = useRef(sourceKey);
  if (previousSource.current !== sourceKey) {
    previousSource.current = sourceKey;
    lastGoodRef.current = null;
    lastGrabAtRef.current = 0;
    capturedKeyRef.current = null;
  }

  const grabFrame = useCallback(
    async (allowTrick: boolean): Promise<string | null> => {
      const { engine: eng, seekPreviewEnabled: seek, fullQuality: full } = latest.current;
      if (eng === "html5") {
        const v = videoMountRef.current?.querySelector("video") as HTMLVideoElement | null;
        return v ? captureFrame(v, full) : null;
      }
      const mpvImg = await captureMpvFrame(full);
      if (mpvImg) return mpvImg;
      if (allowTrick && seek) return trickplayGet(getPlaybackPosition());
      return null;
    },
    [videoMountRef],
  );

  const captureExitSnapshot = useCallback(async () => {
    const {
      src: s,
      durationSec: dur,
      resolvedImdbId: resolved,
      resolvedImdbVerified: verified,
      snapshotsOff: off,
    } = latest.current;
    if (off) return;
    const id = snapshotId(s, resolved, verified);
    if (!id) {
      persist(lastGoodRef.current);
      return;
    }
    const cur = getPlaybackPosition();
    if (!Number.isFinite(cur) || cur <= 0) {
      persist(lastGoodRef.current);
      return;
    }
    const ep = s.episode ? `:${s.episode.season}:${s.episode.episode}` : "";
    const key = `${s.meta.id}${ep}|${cur.toFixed(0)}`;
    if (capturedKeyRef.current === key) return;
    capturedKeyRef.current = key;

    if (nearEnd(cur, dur, false)) {
      persist(lastGoodRef.current);
      return;
    }
    const budget = lastGoodRef.current ? EXIT_GRAB_MS : GRAB_FULL_MS;
    // Keep a slow native capture alive after the exit budget expires. Otherwise
    // successful HDR screenshots can arrive after close and never be saved.
    const pending = grabFrame(true)
      .then((fresh) => {
        if (fresh && latest.current.sourceKey === mediaKey(s) && !latest.current.snapshotsOff) {
          const cached = { img: fresh, id, aliases: [s.meta.id] };
          lastGoodRef.current = cached;
          persist(cached);
        }
        return fresh;
      })
      .catch(() => null);
    const fresh = await Promise.race([
      pending,
      new Promise<null>((r) => setTimeout(() => r(null), budget)),
    ]);
    if (!fresh) capturedKeyRef.current = null;
    if (!fresh && latest.current.sourceKey === mediaKey(s)) persist(lastGoodRef.current);
  }, [grabFrame]);

  useEffect(() => {
    if (status !== "playing" || snapshotsOff) return;
    const tick = async () => {
      const {
        src: s,
        durationSec: dur,
        resolvedImdbId: resolved,
        resolvedImdbVerified: verified,
      } = latest.current;
      const id = snapshotId(s, resolved, verified);
      if (!id) return;
      const good = lastGoodRef.current;
      if (good && good.id === id && Date.now() - lastGrabAtRef.current < REFRESH_MS) return;
      const cur = getPlaybackPosition();
      if (!Number.isFinite(cur) || cur <= 0 || nearEnd(cur, dur, false)) return;
      const img = await grabFrame(true);
      if (!img) return;
      lastGrabAtRef.current = Date.now();
      if (latest.current.sourceKey !== mediaKey(s) || latest.current.snapshotsOff) return;
      const cached = { img, id, aliases: [s.meta.id] };
      lastGoodRef.current = cached;
      persist(cached);
    };
    const warm = window.setTimeout(() => void tick(), WARM_MS);
    const id = window.setInterval(() => void tick(), CACHE_MS);
    return () => {
      window.clearTimeout(warm);
      window.clearInterval(id);
    };
  }, [status, snapshotsOff, grabFrame, sourceKey]);

  useEffect(() => {
    const flush = () => persist(lastGoodRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  return { captureExitSnapshot };
}
