import { ListVideo, Play, X } from "lucide-react";
import { useStartQueue } from "@/hooks/use-start-queue";
import { useT } from "@/lib/i18n";
import { queueClear, useQueue, useQueueResumeItem } from "@/lib/queue";
import "./queue-continue-card.css";
import { useEffect, useState } from "react";
import { QueueClearConfirm } from "./queue-clear-confirm";
import { QueueContinueTitle } from "./queue-continue-title";

export function QueueContinueCard() {
  const t = useT();
  const queue = useQueue();
  const resumeItem = useQueueResumeItem();
  const startQueue = useStartQueue();
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (queue.length === 0) setConfirmClear(false);
  }, [queue.length]);

  if (!resumeItem) return null;

  const episode = resumeItem.episode;
  const title = episode
    ? [
        resumeItem.meta.name,
        `S${episode.imdbSeason ?? episode.season} E${episode.imdbEpisode ?? episode.episode}`,
        episode.name,
      ]
        .filter(Boolean)
        .join(" · ")
    : resumeItem.meta.name;

  const resumeIndex = queue.findIndex((item) => item.id === resumeItem.id);
  const remainingQueue =
    resumeIndex >= 0
      ? queue.slice(resumeIndex + 1)
      : queue.filter((item) => item.id !== resumeItem.id);

  const currentPoster = resumeItem.meta.poster;
  const nextPosters = Array.from(
    new Set(
      remainingQueue
        .map((item) => item.meta.poster)
        .filter((poster): poster is string => Boolean(poster))
        .filter((poster) => poster !== currentPoster),
    ),
  ).slice(0, 3);

  return (
    <div className="queue-continue-card">
      <button
        type="button"
        className="queue-continue-card__play"
        onClick={() => startQueue({ resume: true })}
        aria-label={`${t("Continue your watching queue?")} ${title}`}
      >
        <span
          className="queue-continue-card__posters"
          data-next-count={nextPosters.length}
          aria-hidden="true"
        >
          <span className="queue-continue-card__poster queue-continue-card__poster--current">
            {currentPoster ? (
              <img src={currentPoster} alt="" draggable={false} />
            ) : (
              <ListVideo size={40} />
            )}
          </span>

          {nextPosters.map((poster) => (
            <span key={poster} className="queue-continue-card__poster">
              <img src={poster} alt="" draggable={false} />
            </span>
          ))}
        </span>

        <span className="queue-continue-card__shade" aria-hidden="true" />

        <span className="queue-continue-card__caption">
          <Play size={17} fill="currentColor" aria-hidden="true" />
          <span className="queue-continue-card__heading">{t("Continue your watching queue?")}</span>
          <QueueContinueTitle text={title} />
        </span>
      </button>

      <button
        type="button"
        className="queue-continue-card__clear"
        onClick={() => setConfirmClear(true)}
        aria-label={t("Clear your queue")}
      >
        <X size={14} aria-hidden="true" />
        <span className="queue-continue-card__clear-label" aria-hidden="true">
          <span>{t("Clear your queue")}</span>
        </span>
      </button>
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
