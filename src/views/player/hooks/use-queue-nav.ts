import { useEffect, useRef } from "react";
import type { Meta } from "@/lib/cinemeta";
import { queueArchive, useQueue } from "@/lib/queue";
import { queueSessionIndex } from "@/lib/queue-session";
import type { PickerOptions, PlayEpisode, PlayerSrc } from "@/lib/view";

export function useQueueNav(params: {
  src: PlayerSrc;
  adjacent: { prev: PlayEpisode | null; next: PlayEpisode | null };
  canChangeEpisode: boolean;
  isLiveLike: boolean;
  queueDrivesNav: boolean;
  instantPlay?: boolean;
  goToEpisode: (ep: PlayEpisode | null) => void;
  openPicker: (meta: Meta, episode?: PlayEpisode, opts?: PickerOptions) => void;
}) {
  const {
    src,
    adjacent,
    canChangeEpisode,
    isLiveLike,
    queueDrivesNav,
    instantPlay = false,
    goToEpisode,
    openPicker,
  } = params;
  const queue = useQueue();
  const queueTransitionItemIdRef = useRef<string | null>(null);
  const isQueueTransitionActive = () =>
    queueTransitionItemIdRef.current !== null &&
    queueTransitionItemIdRef.current === src.queueItemId;

  useEffect(() => {
    if (queueTransitionItemIdRef.current !== src.queueItemId) {
      queueTransitionItemIdRef.current = null;
    }
  }, [src.queueItemId]);

  const currentQueueIdx = queueSessionIndex(src, queue);
  const queueNav = queueDrivesNav && !isLiveLike && currentQueueIdx >= 0;
  const detachedQueueSource =
    queueDrivesNav && !isLiveLike && src.queueItemId != null && currentQueueIdx < 0;
  const currentQueueItem = queueNav ? (queue[currentQueueIdx] ?? null) : null;
  const queueNextItem = queueNav ? (queue[currentQueueIdx + 1] ?? null) : null;
  const queuePrevItem =
    queueNav && currentQueueIdx > 0 ? (queue[currentQueueIdx - 1] ?? null) : null;

  const queueTransitionActive = isQueueTransitionActive() || detachedQueueSource;
  const hasNextEpisodeNow = queueTransitionActive
    ? false
    : queueNav
      ? !!queueNextItem
      : canChangeEpisode && !!adjacent.next;
  const hasPrevEpisodeNow = queueTransitionActive
    ? false
    : queueNav
      ? !!queuePrevItem
      : canChangeEpisode && !!adjacent.prev;

  const playNext = () => {
    if (isQueueTransitionActive() || detachedQueueSource) return;

    if (queueNav) {
      if (currentQueueItem && queueNextItem) {
        queueTransitionItemIdRef.current = currentQueueItem.id;
        if (!queueArchive(currentQueueItem.id, "skipped")) {
          queueTransitionItemIdRef.current = null;
          return;
        }
        openPicker(queueNextItem.meta, queueNextItem.episode, {
          queueItemId: queueNextItem.id,
          autoPlay: instantPlay,
          resume: true,
        });
      }
      return;
    }

    if (canChangeEpisode && adjacent.next) {
      goToEpisode(adjacent.next);
    }
  };

  const playPrev = () => {
    if (isQueueTransitionActive() || detachedQueueSource) return;

    if (queueNav) {
      if (queuePrevItem) {
        openPicker(queuePrevItem.meta, queuePrevItem.episode, {
          queueItemId: queuePrevItem.id,
          autoPlay: instantPlay,
          resume: true,
        });
      }
      return;
    }

    if (canChangeEpisode && adjacent.prev) {
      goToEpisode(adjacent.prev);
    }
  };

  const playNextRef = useRef(playNext);
  playNextRef.current = playNext;
  const playPrevRef = useRef(playPrev);
  playPrevRef.current = playPrev;

  return { hasNextEpisodeNow, hasPrevEpisodeNow, playNext, playPrev, playNextRef, playPrevRef };
}
