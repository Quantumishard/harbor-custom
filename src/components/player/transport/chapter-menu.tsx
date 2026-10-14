import { ListTree, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chapter } from "@/lib/player/bridge";
import { useT } from "@/lib/i18n";
import { fmtTime } from "./transport-utils";

export function ChapterMenu({
  chapters,
  positionSec,
  onSeek,
  onOpenChange,
}: {
  chapters: Chapter[];
  positionSec: number;
  onSeek: (sec: number) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ordered = useMemo(
    () =>
      [...chapters]
        .filter((c) => Number.isFinite(c.startSec))
        .sort((a, b) => a.startSec - b.startSec),
    [chapters],
  );
  const activeIndex = ordered.reduce(
    (found, chapter, index) => (chapter.startSec <= positionSec + 0.25 ? index : found),
    -1,
  );

  const setMenuOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open, setMenuOpen]);

  if (!ordered.length) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setMenuOpen(!open)}
        aria-label={t("Chapters")}
        aria-expanded={open}
        className={`flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-white transition-colors hover:bg-white/15 ${open ? "bg-white/15" : ""}`}
      >
        <ListTree size={19} />
        <span className="hidden xl:inline">{t("Chapters")}</span>
      </button>
      {open && (
        <div className="absolute right-0 bottom-12 z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/15 bg-[#151515]/95 text-white shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <div className="font-semibold">{t("Chapters")}</div>
              <div className="text-xs text-white/55">{ordered.length}</div>
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label={t("Close chapters")}
              className="rounded-md p-1.5 hover:bg-white/10"
            >
              <X size={17} />
            </button>
          </div>
          <div className="max-h-[min(26rem,55vh)] overflow-y-auto p-2">
            {ordered.map((chapter, index) => (
              <button
                type="button"
                key={`${chapter.startSec}-${index}`}
                onClick={() => {
                  onSeek(chapter.startSec);
                  setMenuOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-white/10 ${index === activeIndex ? "bg-white/12" : ""}`}
              >
                <span className="w-7 shrink-0 text-right text-xs tabular-nums text-white/45">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {chapter.title || t("Chapter {chapter}", { chapter: index + 1 })}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-white/50">
                  {fmtTime(chapter.startSec)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
