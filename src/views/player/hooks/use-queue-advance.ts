import { useEffect, useRef, type RefObject } from "react";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import { isNaturalEnd } from "@/lib/player/playback-end";
import type { Meta } from "@/lib/cinemeta";
import type { PickerOptions, PlayEpisode, PlayerSrc } from "@/lib/view";
import { queueSessionIndex } from "@/lib/queue-session";
import { getSleepAtEnd, queueArchive, setSleepAtEnd, type QueueItem } from "@/lib/queue";
import { completedEpisodeSource } from "@/lib/download/completed-episode-source";

const STUB_MAX_SEC = 150;

export function useQueueAdvance(params: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  queue: QueueItem[];
  isLive: boolean;
  roomGuest: boolean;
  inRoom: boolean;
  queueDrivesNav: boolean;
  instantPlay: boolean;
  startedNearEndRef: RefObject<boolean>;
  openPicker: (meta: Meta, episode?: PlayEpisode, opts?: PickerOptions) => void;
  replacePlayerSrc: (src: PlayerSrc) => void;
  closePlayer: () => void | Promise<void>;
}) {
  const {
    src,
    snap,
    queue,
    isLive,
    roomGuest,
    inRoom,
    queueDrivesNav,
    instantPlay,
    startedNearEndRef,
    openPicker,
    replacePlayerSrc,
    closePlayer,
  } = params;
  const firedForRef = useRef<string | null>(null);
  const latestSrcRef = useRef(src);
  latestSrcRef.current = src;
  const latestQueueRef = useRef(queue);
  latestQueueRef.current = queue;
  const advanceRevisionRef = useRef(0);
  useEffect(
    () => () => {
      advanceRevisionRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    firedForRef.current = null;
  }, [src.url]);

  useEffect(() => {
    if (isLive || roomGuest) return;

    const currentIndex = queueSessionIndex(src, queue);
    const currentItem = currentIndex >= 0 ? queue[currentIndex] : undefined;
    const sleepAtEnd = getSleepAtEnd();

    const queueActive = queueDrivesNav && !!currentItem;
    if (!queueActive && !sleepAtEnd) return;
    if (snap.durationSec <= STUB_MAX_SEC) return;
    if (startedNearEndRef.current) return;
    if (!isNaturalEnd(snap, getPlaybackPosition())) return;
    if (firedForRef.current === src.url) return;

    firedForRef.current = src.url;

    // Capture the successor before removing the completed item.
    const nextItem = queueActive ? queue[currentIndex + 1] : undefined;

    if (queueActive && !queueArchive(currentItem.id, "completed")) {
      firedForRef.current = null;
      return;
    }

    if (queueActive) {
      if (nextItem) {
        const request = ++advanceRevisionRef.current;
        const stillCurrent = () =>
          advanceRevisionRef.current === request &&
          latestSrcRef.current === src &&
          latestQueueRef.current.some((item) => item.id === nextItem.id);
        const openNextSource = () => {
          if (!stillCurrent()) return;
          openPicker(nextItem.meta, nextItem.episode, {
            autoPlay: instantPlay,
            resume: true,
            queueItemId: nextItem.id,
          });
        };
        if (inRoom || !nextItem.episode) {
          openNextSource();
          return;
        }
        void completedEpisodeSource(nextItem.meta, nextItem.episode, {
          imdbId:
            nextItem.episode.imdbId ??
            (nextItem.meta.id.startsWith("tt") ? nextItem.meta.id : undefined),
          isAnime: nextItem.meta.id === src.meta.id ? src.isAnime : undefined,
        }).then((download) => {
          if (!stillCurrent()) return;
          if (download) replacePlayerSrc({ ...download, queueItemId: nextItem.id, resume: true });
          else openNextSource();
        }, openNextSource);
        return;
      }

      if (sleepAtEnd) setSleepAtEnd(false);
      void closePlayer();
      return;
    }

    if (sleepAtEnd) {
      setSleepAtEnd(false);
      void closePlayer();
    }
  }, [
    src,
    snap,
    queue,
    isLive,
    roomGuest,
    inRoom,
    queueDrivesNav,
    instantPlay,
    startedNearEndRef,
    openPicker,
    replacePlayerSrc,
    closePlayer,
  ]);
}
