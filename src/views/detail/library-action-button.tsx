import { Ban, Bookmark, Check, ChevronDown, ListPlus, Loader2, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { AnchoredMenu } from "@/components/anchored-menu";
import { HoverTooltip } from "@/components/hover-tooltip";
import { emitListToast } from "@/components/lists/list-toast";
import { confirmAction } from "@/lib/confirm-action";
import { useT } from "@/lib/i18n";
import {
  setLibraryAddScope,
  setLibraryMembership,
  useLibraryAddScope,
  type LibraryActionInput,
  type LibraryAddScope,
  type LibraryActionResult,
} from "@/lib/library-action";

function MenuItem({
  icon,
  label,
  active = false,
  danger = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start text-[13.5px] transition-colors ${
        danger
          ? "text-ink-muted hover:bg-danger/15 hover:text-danger"
          : active
            ? "text-ink"
            : "text-ink-muted hover:bg-elevated/60 hover:text-ink"
      }`}
    >
      <span className="flex items-center gap-2.5">
        {icon}
        {label}
      </span>
      {active && <Check size={15} className="shrink-0 text-ink" />}
    </button>
  );
}

function summarize(
  t: (key: string, vars?: Record<string, string | number>) => string,
  result: LibraryActionResult,
): { text: string; error: boolean } {
  const updated = result.outcomes.filter((outcome) => outcome.status === "updated");
  const issues = result.outcomes.filter((outcome) => outcome.status !== "updated");
  if (issues.length === 0) {
    const providers = updated.map((outcome) => t(outcome.provider)).join(", ");
    return {
      text: providers ? t("Updated: {providers}.", { providers }) : t("No changes were made."),
      error: false,
    };
  }
  const lines: string[] = [];
  if (updated.length > 0) {
    lines.push(
      t("Updated: {providers}.", {
        providers: updated.map((outcome) => t(outcome.provider)).join(", "),
      }),
    );
  }
  for (const issue of issues) {
    lines.push(`${t(issue.provider)}: ${t(issue.reason ?? "The action could not be completed.")}`);
  }
  return { text: lines.join(" · "), error: true };
}

export function LibraryActionButton({
  input,
  inWatchlist,
  canDrop,
  onDrop,
  syncLabel,
}: {
  input: LibraryActionInput;
  inWatchlist: boolean;
  canDrop: boolean;
  onDrop: () => void;
  syncLabel: string;
}) {
  const t = useT();
  const scope = useLibraryAddScope();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const run = async (on: boolean, actionScope: LibraryAddScope) => {
    if (busy) return;
    setMenuOpen(false);
    if (!on && actionScope === "all") {
      const confirmed = await confirmAction({
        title: t("Remove from all trackers?"),
        message: t(
          "This removes the title from every connected tracker. Simkl completed or watching titles stay unchanged; AniList and MyAnimeList list progress may be removed.",
        ),
        confirmLabel: t("Remove from all trackers"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const result = await setLibraryMembership(input, on, actionScope);
      if (on) setLibraryAddScope(actionScope);
      const summary = summarize(t, result);
      emitListToast(summary.text, summary.error ? "error" : "success");
    } catch (error) {
      emitListToast(
        error instanceof Error ? t(error.message) : t("The action could not be completed."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel = inWatchlist
    ? t("In library")
    : scope === "all"
      ? t("Add to all trackers")
      : t("Save to library");

  return (
    <div className="relative shrink-0">
      <HoverTooltip label={syncLabel} align="center" className="shrink-0">
        <div
          ref={anchorRef}
          className={`flex h-12 items-stretch overflow-hidden rounded-full transition-[transform,background-color,border-color] duration-200 ${
            inWatchlist
              ? "bg-ink/15 text-ink hover:bg-ink/20"
              : "bg-canvas/80 text-ink hover:bg-canvas/95"
          }`}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (inWatchlist) setMenuOpen((value) => !value);
              else void run(true, scope);
            }}
            className="flex items-center gap-2.5 whitespace-nowrap px-5 text-[15px] font-medium transition-transform duration-200 active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? (
              <Loader2 size={17} className="animate-spin" />
            ) : inWatchlist ? (
              <Check size={18} strokeWidth={2.4} />
            ) : (
              <ListPlus size={17} strokeWidth={2.1} />
            )}
            {primaryLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={t("More actions")}
            onClick={() => setMenuOpen((value) => !value)}
            className={`flex w-10 items-center justify-center border-s transition-colors disabled:opacity-60 ${
              inWatchlist ? "border-ink/15 hover:bg-ink/10" : "border-ink/10 hover:bg-canvas/95"
            }`}
          >
            <ChevronDown
              size={16}
              className={`text-ink-muted transition-transform ${menuOpen ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </HoverTooltip>
      <AnchoredMenu
        anchorRef={anchorRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        width={280}
      >
        <div className="overflow-hidden rounded-2xl border border-edge bg-raised py-1.5 shadow-[0_24px_60px_-15px_rgba(0,0,0,0.7)]">
          <MenuItem
            icon={<Bookmark size={14} strokeWidth={2} />}
            label={t("Save to library")}
            active={scope === "library"}
            onClick={() => void run(true, "library")}
          />
          <MenuItem
            icon={<ListPlus size={14} strokeWidth={2} />}
            label={t("Add to all trackers")}
            active={scope === "all"}
            onClick={() => void run(true, "all")}
          />
          <div className="my-1 h-px bg-edge-soft" />
          <MenuItem
            icon={<Trash2 size={14} strokeWidth={2} />}
            label={t("Remove from library")}
            danger
            onClick={() => void run(false, "library")}
          />
          <MenuItem
            icon={<Trash2 size={14} strokeWidth={2} />}
            label={t("Remove from all trackers")}
            danger
            onClick={() => void run(false, "all")}
          />
          {canDrop && (
            <>
              <div className="my-1 h-px bg-edge-soft" />
              <MenuItem
                icon={<Ban size={14} strokeWidth={2.1} />}
                label={t("Drop show")}
                danger
                onClick={() => {
                  setMenuOpen(false);
                  onDrop();
                }}
              />
            </>
          )}
        </div>
      </AnchoredMenu>
    </div>
  );
}
