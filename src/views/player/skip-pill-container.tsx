import { useEffect, useMemo, useRef, useState } from "react";
import { getPlaybackPosition, usePlaybackPosition } from "@/lib/player/playback-clock";
import { SkipPill } from "@/components/player/skip-pill";
import { BpSkipPill } from "@/views/big-picture/player/bp-skip-pill";
import {
  activeSegment,
  resolveSkipPillProgress,
  resolveSkipPillWindowMs,
  resolveSkipPillWindowProgress,
  type SkipSegment,
} from "@/lib/skip-intro";
import { useSettings } from "@/lib/settings";
import type { SpoilerMask } from "@/lib/spoilers";
import type { PlayEpisode } from "@/lib/view";

export function nextEpisodeLead(setting: number, durationSec: number): number {
  if (setting === 0) return 0;
  if (setting > 0) return setting;
  return Math.min(45, Math.max(15, Math.round(durationSec * 0.04)));
}

/**
 * A credits range from a provider can stop before the file does: a next-episode
 * preview or an after-credits scene follows it. Within this window of the real
 * end the outro still counts as the end of the episode, so seeking to the next
 * one is not skipping anything the viewer wanted to see.
 */
const OUTRO_END_TOLERANCE_SEC = 5;

export function SkipPillContainer({
  engine,
  skipSegments,
  durationSec,
  hasNextEpisode,
  hasNextEpDisplay,
  nextEp,
  nextEpMask,
  visible,
  allowAutoSkip = true,
  tenFoot = false,
  onSkip,
  onNextEpisode,
  onCancelAutoNext,
}: {
  engine: "html5" | "mpv";
  skipSegments: SkipSegment[];
  durationSec: number;
  hasNextEpisode: boolean;
  hasNextEpDisplay: boolean;
  nextEp: PlayEpisode | null;
  nextEpMask?: SpoilerMask;
  visible: boolean;
  allowAutoSkip?: boolean;
  /** Swap the mouse pill for the D-pad one. All the timing logic is shared. */
  tenFoot?: boolean;
  onSkip: (sec: number) => void;
  onNextEpisode: () => void;
  onCancelAutoNext: () => void;
}) {
  const { settings } = useSettings();
  const positionSec = usePlaybackPosition();
  const realActiveSkip = activeSegment(skipSegments, positionSec);
  const leadSec = nextEpisodeLead(settings.nextEpisodeLeadSec, durationSec);
  // Credits that stop well before the file does are not the end of the episode:
  // jumping to the next one would skip whatever follows (a preview, an epilogue
  // scene). Only an outro that runs into the end may offer the next episode.
  const outroReachesEnd =
    durationSec <= 0 ||
    realActiveSkip?.kind !== "outro" ||
    realActiveSkip.endSec >= durationSec - OUTRO_END_TOLERANCE_SEC;
  const syntheticOutro = useMemo(() => {
    if (realActiveSkip) return null;
    if (!hasNextEpisode) return null;
    if (durationSec <= 0) return null;
    if (leadSec <= 0) return null;
    const remaining = durationSec - positionSec;
    if (remaining > leadSec || remaining < 0.5) return null;
    // A real outro that stops early does not cover the tail, so it must not
    // suppress the synthetic one: that is what brings the card back for the last
    // lead seconds of the actual episode.
    const hasFinalOutro = skipSegments.some(
      (s) => s.kind === "outro" && s.endSec >= durationSec - OUTRO_END_TOLERANCE_SEC,
    );
    if (hasFinalOutro) return null;
    return {
      kind: "outro" as const,
      startSec: Math.max(0, durationSec - leadSec),
      endSec: durationSec,
      source: "chapters" as const,
    };
  }, [realActiveSkip, hasNextEpisode, durationSec, positionSec, skipSegments, leadSec]);
  const remainingSec = Math.max(0, durationSec - positionSec);

  const autoSkippedRef = useRef<SkipSegment | null>(null);
  useEffect(() => {
    autoSkippedRef.current = null;
  }, [skipSegments]);
  useEffect(() => {
    if (!allowAutoSkip || positionSec <= 0 || !realActiveSkip) return;
    const wantSkip =
      (realActiveSkip.kind === "intro" && settings.autoSkipIntro) ||
      (realActiveSkip.kind === "recap" && settings.autoSkipRecap) ||
      (realActiveSkip.kind === "outro" && settings.autoSkipOutro) ||
      (realActiveSkip.kind === "ad" && settings.autoSkipAd);
    if (!wantSkip) return;
    if (autoSkippedRef.current === realActiveSkip) return;
    autoSkippedRef.current = realActiveSkip;
    onSkip(realActiveSkip.endSec);
  }, [
    settings.autoSkipIntro,
    settings.autoSkipRecap,
    settings.autoSkipOutro,
    settings.autoSkipAd,
    allowAutoSkip,
    positionSec,
    realActiveSkip,
    onSkip,
  ]);

  const currentSkip = realActiveSkip ?? syntheticOutro;
  const currentKey = currentSkip
    ? `${currentSkip.kind}:${Math.round(currentSkip.startSec)}:${Math.round(currentSkip.endSec)}`
    : null;
  const buttonKey = realActiveSkip && settings.showSkipButton ? currentKey : null;

  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const prevSkipKeyRef = useRef<string | null>(null);
  useEffect(() => {
    setHiddenKey(null);
    prevSkipKeyRef.current = null;
  }, [skipSegments]);
  useEffect(() => {
    if (prevSkipKeyRef.current && prevSkipKeyRef.current !== buttonKey) {
      const previousKey = prevSkipKeyRef.current;
      setHiddenKey((prev) => (prev === previousKey ? null : prev));
    }
    prevSkipKeyRef.current = buttonKey;
  }, [buttonKey]);

  const skipHidden = buttonKey != null && hiddenKey === buttonKey;

  // The pill's segment anchor: the playback position where it appeared, so
  // resuming mid-intro still gets a full line instead of one that is already two
  // thirds gone.
  const skipStartSec = currentSkip?.startSec ?? 0;
  const anchorRef = useRef<{ key: string; positionSec: number } | null>(null);
  const anchorSec =
    currentSkip && currentKey
      ? anchorRef.current?.key === currentKey
        ? anchorRef.current.positionSec
        : Math.max(currentSkip.startSec, positionSec)
      : 0;

  // The auto-hide window is a timer, not a progress bar: "10" means ten seconds
  // of real time whether the video is playing, paused or being seeked. Its start
  // therefore lives on the wall clock, next to (not instead of) the playback
  // anchor above.
  const windowStartRef = useRef<{ key: string; atMs: number } | null>(null);
  const [windowTickAt, setWindowTickAt] = useState(0);
  useEffect(() => {
    if (!currentKey) {
      anchorRef.current = null;
      windowStartRef.current = null;
      return;
    }
    if (anchorRef.current?.key === currentKey) return;
    anchorRef.current = {
      key: currentKey,
      positionSec: Math.max(skipStartSec, getPlaybackPosition()),
    };
  }, [currentKey, skipStartSec]);

  // The window starts when the pill can actually be seen. Big Picture keeps this
  // mounted under the resume prompt, and spending the timer on a button nobody
  // could press would retire it before the viewer got a look at it.
  useEffect(() => {
    if (!currentKey) {
      windowStartRef.current = null;
      return;
    }
    if (!visible) return;
    if (windowStartRef.current?.key === currentKey) return;
    windowStartRef.current = { key: currentKey, atMs: Date.now() };
  }, [currentKey, visible]);

  // The credits pill that leads into the Up Next card is exempt from the window:
  // retiring it early would leave the card without the segment it needs.
  const upNextAvailable = hasNextEpDisplay && leadSec > 0 && nextEp != null;
  const pillOffersUpNext = upNextAvailable && outroReachesEnd;
  const keepsUpNextPrompt = currentSkip?.kind === "outro" && pillOffersUpNext;

  // The ad-skip pill is the only way out of an injected ad, so the window never
  // retires it: it leaves when the ad does.
  const windowMs =
    buttonKey && !keepsUpNextPrompt && currentSkip != null && currentSkip.kind !== "ad"
      ? resolveSkipPillWindowMs({
          segment: currentSkip,
          appearedAtSec: anchorSec,
          hideSec: settings.skipButtonHideSec,
        })
      : 0;

  // Ticks only to repaint the line; the window itself is the timeout below.
  useEffect(() => {
    if (windowMs <= 0 || skipHidden || !visible) return;
    const start = windowStartRef.current;
    if (!start || start.key !== buttonKey) return;
    setWindowTickAt(Date.now());
    const id = window.setInterval(() => setWindowTickAt(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [buttonKey, windowMs, skipHidden, visible]);

  useEffect(() => {
    if (windowMs <= 0 || skipHidden || !visible) return;
    const start = windowStartRef.current;
    if (!start || start.key !== buttonKey) return;
    const elapsedMs = Date.now() - start.atMs;
    const id = window.setTimeout(
      () => setHiddenKey((prev) => (prev === buttonKey ? prev : buttonKey)),
      Math.max(0, windowMs - elapsedMs),
    );
    return () => window.clearTimeout(id);
  }, [buttonKey, windowMs, skipHidden, visible]);

  const segmentProgress = currentSkip
    ? resolveSkipPillProgress({ segment: currentSkip, positionSec, appearedAtSec: anchorSec })
    : 0;
  const windowElapsedMs =
    windowMs > 0 && windowStartRef.current?.key === buttonKey
      ? Math.max(0, windowTickAt - windowStartRef.current.atMs)
      : 0;
  const progress =
    windowMs > 0 ? resolveSkipPillWindowProgress(windowElapsedMs, windowMs) : segmentProgress;

  const displaySkip = settings.showSkipButton && !skipHidden ? realActiveSkip : null;
  const activeSkip = displaySkip ?? syntheticOutro;

  const shared = {
    segment: activeSkip,
    progress,
    hasNextEp: pillOffersUpNext,
    nextEp,
    nextEpMask,
    remainingSec,
    leadSec,
    visible,
    onSkip: () => {
      if (activeSkip) onSkip(activeSkip.endSec);
    },
    onNextEpisode,
    onCancelAutoNext,
  };

  if (tenFoot) return <BpSkipPill {...shared} />;
  return <SkipPill engine={engine} {...shared} />;
}
