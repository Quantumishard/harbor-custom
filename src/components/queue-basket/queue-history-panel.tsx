import { useMemo } from "react";
import { CheckCircle2, History, ListVideo, Play, SkipForward, Trash2 } from "lucide-react";
import { useT, useUiLanguage } from "@/lib/i18n";
import type { QueueHistoryItem } from "@/lib/queue";

type QueueHistoryPanelProps = {
  history: QueueHistoryItem[];
  onPlay: (item: QueueHistoryItem) => void;
  onClear?: () => void;
};

export function QueueHistoryPanel({ history, onPlay, onClear }: QueueHistoryPanelProps) {
  const t = useT();

  const language = useUiLanguage();
  const historyDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(language, { dateStyle: "medium" }),
    [language],
  );

  const formatHistoryStatus = (item: QueueHistoryItem) => {
    const date = historyDateFormatter.format(item.recordedAt);

    return t(item.reason === "completed" ? "Completed on {date}" : "Skipped on {date}", {
      date,
    });
  };

  if (history.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <History size={30} className="text-ink-subtle" aria-hidden="true" />
        <div>
          <p className="font-medium">{t("No queue history yet")}</p>
          <p className="mt-1 text-sm text-ink-subtle">
            {t("Completed and skipped queue items will appear here.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {history.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onPlay(item)}
              className="group flex w-full items-center gap-3 rounded-xl bg-raised p-3 text-start transition-colors hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-white/5">
                {item.meta.poster ? (
                  <img
                    src={item.meta.poster}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ListVideo
                    size={20}
                    className="m-auto h-full text-ink-subtle"
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-semibold">{item.meta.name}</p>

                {item.episode && (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-subtle">
                    {`S${item.episode.imdbSeason ?? item.episode.season} · E${
                      item.episode.imdbEpisode ?? item.episode.episode
                    }`}
                    {item.episode.name ? ` · ${item.episode.name}` : ""}
                  </p>
                )}

                <span className="mt-2 flex items-center gap-1.5 text-xs text-ink-subtle">
                  {item.reason === "completed" ? (
                    <CheckCircle2 size={13} aria-hidden="true" />
                  ) : (
                    <SkipForward size={13} aria-hidden="true" />
                  )}
                  {formatHistoryStatus(item)}
                </span>
              </div>

              <Play
                size={17}
                className="shrink-0 text-ink-subtle transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ol>

      {onClear && (
        <footer className="border-t border-edge p-4">
          <button
            type="button"
            onClick={onClear}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Trash2 size={16} aria-hidden="true" />
            {t("Clear history")}
          </button>
        </footer>
      )}
    </>
  );
}
