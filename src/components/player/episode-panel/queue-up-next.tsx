import { ChevronLeft, History, Trash2 } from "lucide-react";
import { Play } from "@/components/icons/play-filled";
import type { Meta } from "@/lib/cinemeta";
import {
  queueClear,
  queueIndexOf,
  queueItemAfter,
  queueRemove,
  useQueue,
  useQueueHistory,
} from "@/lib/queue";
import { usePlayerNavigation, type PlayEpisode } from "@/lib/view";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { splitFranchiseDisplaySeason } from "@/lib/streams/anime-identity-core";
import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { QueueHistoryPanel } from "@/components/queue-basket/queue-history-panel";
import { QueueClearConfirm } from "@/components/queue-basket/queue-clear-confirm";
import { useSettings } from "@/lib/settings";

export function QueueUpNext({
  meta,
  currentEpisode,
  roomGuest,
  open,
  onClose,
}: {
  meta: Meta;
  currentEpisode: PlayEpisode | undefined;
  roomGuest: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { settings } = useSettings();
  const queue = useQueue();
  const history = useQueueHistory();
  const [showHistory, setShowHistory] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyBackButtonRef = useRef<HTMLButtonElement>(null);
  const restoreHistoryButtonFocusRef = useRef(false);
  useEffect(() => {
    if (!open || roomGuest) {
      restoreHistoryButtonFocusRef.current = false;
      setShowHistory(false);
      setConfirmClear(false);
    }
  }, [open, roomGuest]);
  useEffect(() => {
    if (!open || roomGuest) return;

    if (showHistory) {
      historyBackButtonRef.current?.focus();
      return;
    }

    if (restoreHistoryButtonFocusRef.current) {
      restoreHistoryButtonFocusRef.current = false;
      historyButtonRef.current?.focus();
    }
  }, [open, roomGuest, showHistory]);
  const { openPicker } = usePlayerNavigation();

  if (showHistory) {
    return (
      <div className="mt-5 flex min-h-0 flex-col gap-2 border-t border-edge-soft/60 pt-4">
        <div className="px-1">
          <button
            ref={historyBackButtonRef}
            type="button"
            onClick={() => {
              restoreHistoryButtonFocusRef.current = true;
              setShowHistory(false);
            }}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-subtle transition-colors hover:text-ink"
          >
            <ChevronLeft size={16} className="rtl:rotate-180" aria-hidden="true" />
            {t("Back to watching queue")}
          </button>

          <h3 className="mt-3 text-[11px] font-bold uppercase tracking-[0.22em] text-ink-subtle">
            {t("Watching history")}
          </h3>
        </div>

        <QueueHistoryPanel
          history={history}
          onPlay={(item) => {
            openPicker(item.meta, item.episode, {
              autoPlay: settings.instantPlay,
              resume: true,
            });
            onClose();
          }}
        />
      </div>
    );
  }

  const currentIdx = queueIndexOf(meta, currentEpisode);
  const currentId = currentIdx >= 0 ? (queue[currentIdx]?.id ?? null) : null;
  const nextId = queueItemAfter(meta, currentEpisode)?.id ?? null;
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-edge-soft/60 pt-4">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.22em] text-ink-subtle">
          {t("In your watching queue")}
          <span className="ms-1.5 font-semibold tabular-nums text-ink-subtle/70">
            {queue.length}
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          {!roomGuest && history.length > 0 && (
            <button
              ref={historyButtonRef}
              type="button"
              onClick={() => setShowHistory(true)}
              aria-label={t("Watching history")}
              title={t("Watching history")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-canvas/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <History size={15} aria-hidden="true" />
            </button>
          )}

          {!roomGuest && queue.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="text-[11px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              {t("Clear")}
            </button>
          )}
        </div>
      </div>
      {queue.length === 0 && (
        <p role="status" className="px-1 py-5 text-sm text-ink-subtle">
          {t("Your queue is empty. Add an item or switch to This show.")}
        </p>
      )}
      {queue.map((item, i) => {
        const isCurrent = item.id === currentId;
        const isNextUp = !isCurrent && item.id === nextId;
        const partSeason = item.episode
          ? (splitFranchiseDisplaySeason(parseKitsuId(item.episode.kitsuStreamId ?? "")) ??
            splitFranchiseDisplaySeason(parseKitsuId(item.meta.id)))
          : null;
        const queueEpLabel =
          item.episode != null
            ? partSeason != null
              ? `S${partSeason} · E${item.episode.episode}`
              : `S${item.episode.imdbSeason ?? item.episode.season} · E${item.episode.imdbEpisode ?? item.episode.episode}`
            : null;
        return (
          <div
            key={item.id}
            className={`group flex items-center gap-2.5 rounded-xl p-2 transition-colors ${
              isNextUp
                ? "bg-accent/12 ring-1 ring-accent/35"
                : isCurrent
                  ? "bg-elevated/70"
                  : "bg-elevated/40"
            }`}
          >
            <span
              className={`w-5 shrink-0 text-center text-[12px] font-bold tabular-nums ${
                isNextUp ? "text-accent" : "text-ink-subtle"
              }`}
            >
              {i + 1}
            </span>
            <button
              type="button"
              disabled={roomGuest || isCurrent}
              onClick={() => {
                // Playing the next episode of the current show must go through
                // auto-play, otherwise keep-same-source never runs.
                openPicker(item.meta, item.episode, {
                  queueItemId: item.id,
                  autoPlay: item.meta.id === meta.id,
                });
                onClose();
              }}
              className="flex min-w-0 flex-1 items-center gap-3 text-start disabled:cursor-default"
            >
              <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-white/[0.06]">
                {(item.meta.background || item.meta.poster) && (
                  <img
                    src={item.meta.background || item.meta.poster}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                {!isCurrent && !roomGuest && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                    <Play size={16} fill="currentColor" className="text-white" />
                  </span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="line-clamp-1 text-[14px] font-medium text-ink">
                  {item.meta.name}
                </span>
                <span className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
                  {isNextUp && (
                    <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                      {t("Next Up")}
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                      {t("Now Playing")}
                    </span>
                  )}
                  {queueEpLabel && <span>{queueEpLabel}</span>}
                </span>
              </div>
            </button>
            <button
              type="button"
              aria-label={t("Remove from watching queue")}
              title={t("Remove from watching queue")}
              onClick={() => queueRemove(item.id)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle opacity-0 transition-all hover:bg-canvas/60 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 size={14} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      {confirmClear && (
        <QueueClearConfirm
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            queueClear();
          }}
        />
      )}
    </div>
  );
}
