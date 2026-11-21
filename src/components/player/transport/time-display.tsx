import { useId, type ReactNode } from "react";
import {
  usePlaybackDownloadedFromP2pGated,
  usePlaybackDownloadedGated,
  usePlaybackPositionGated,
} from "@/lib/player/playback-clock";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { fmtTime } from "./transport-utils";
import type { TimeFormat } from "@/lib/player-chrome";

const TIME_FONT = { fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif' } as const;

/**
 * P2P cache state next to the time: orange while the engine is still filling the
 * cache, green once the selected file is fully downloaded. Clicking it toggles the
 * detailed P2P status chip. Non-P2P streams keep the plain green dot (and no
 * click target) because their "downloaded" fraction is just the HTTP buffer.
 */
function CachedDot({ active }: { active: boolean }): ReactNode {
  const t = useT();
  const { settings, update } = useSettings();
  const tooltipId = useId();
  const downloaded = usePlaybackDownloadedGated(active);
  const fromP2p = usePlaybackDownloadedFromP2pGated(active);
  const cached = downloaded >= 0.999;
  const caching = fromP2p && !cached && downloaded > 0;
  if (!cached && !caching) return null;
  const dotClass = cached
    ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.7)]"
    : "bg-[#fb923c] shadow-[0_0_5px_rgba(251,146,60,0.8)]";
  if (!fromP2p) {
    return (
      <span className="ms-2 inline-block align-middle" title={t("Cached")}>
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      </span>
    );
  }
  const cacheLabel = cached ? t("Cached") : t("Caching");
  const toggleChip = () => update({ playerP2pChip: !settings.playerP2pChip });
  return (
    <span
      role="button"
      tabIndex={0}
      title=""
      aria-label={t("Toggle P2P stats")}
      aria-describedby={tooltipId}
      aria-pressed={settings.playerP2pChip}
      onClick={(event) => {
        event.stopPropagation();
        toggleChip();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        toggleChip();
      }}
      className="group/cache relative ms-2 inline-flex h-3 w-3 shrink-0 cursor-pointer items-center justify-center rounded-full align-middle transition-transform duration-150 ease-out hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 motion-reduce:transition-none motion-reduce:hover:scale-100"
    >
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 w-max -translate-x-1/2 rounded-md border border-white/10 bg-black/85 px-2 py-1 text-[11.5px] font-medium leading-snug text-white/90 opacity-0 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.8)] backdrop-blur-md transition-opacity delay-0 duration-100 group-hover/cache:opacity-100 group-hover/cache:delay-500 group-focus-visible/cache:opacity-100"
      >
        {cacheLabel}
      </span>
    </span>
  );
}

function cycleTitle(fmt: TimeFormat): string {
  return fmt === "remaining" ? "Show total length" : "Show time left";
}

export function TimeStart({
  durationSec,
  timeFormat,
  isLiveChannel,
  tight,
  active,
  stremio,
  onCycle,
}: {
  durationSec: number;
  timeFormat?: TimeFormat;
  isLiveChannel: boolean;
  tight?: boolean;
  active: boolean;
  stremio?: boolean;
  onCycle?: () => void;
}): ReactNode {
  const t = useT();
  const positionSec = usePlaybackPositionGated(active);
  if (isLiveChannel) return null;
  if (stremio) {
    const fmt: TimeFormat = timeFormat ?? "start-end";
    const positionText = fmtTime(positionSec);
    const cls =
      "pointer-events-auto ms-2 shrink-0 font-medium tabular-nums text-[14px] text-white/90";
    const inner =
      fmt === "elapsed-only" ? (
        <>
          {positionText}
          <CachedDot active={active} />
        </>
      ) : (
        <>
          {positionText}
          <span className="mx-1 text-white/55">/</span>
          {fmt === "remaining"
            ? `-${fmtTime(Math.max(0, (durationSec ?? 0) - positionSec))}`
            : fmtTime(durationSec ?? 0)}
          <CachedDot active={active} />
        </>
      );
    if (onCycle) {
      return (
        <button
          type="button"
          onClick={onCycle}
          title={t(cycleTitle(fmt))}
          className={`${cls} cursor-pointer transition-colors hover:text-white`}
        >
          {inner}
        </button>
      );
    }
    return <span className={cls}>{inner}</span>;
  }
  if (tight) return null;
  return (
    <span
      style={TIME_FONT}
      className="shrink-0 text-[15px] font-semibold tabular-nums text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]"
    >
      {fmtTime(positionSec)}
    </span>
  );
}

export function TimeEnd({
  durationSec,
  timeFormat,
  isLiveChannel,
  tight,
  active,
  onCycle,
}: {
  durationSec: number;
  timeFormat?: TimeFormat;
  isLiveChannel: boolean;
  tight?: boolean;
  active: boolean;
  onCycle?: () => void;
}): ReactNode {
  const t = useT();
  const positionSec = usePlaybackPositionGated(active);
  if (isLiveChannel || tight) return null;
  const fmt: TimeFormat = timeFormat ?? "start-end";
  if (fmt === "elapsed-only") return null;
  const duration = durationSec ?? 0;
  const text =
    fmt === "remaining" ? `-${fmtTime(Math.max(0, duration - positionSec))}` : fmtTime(duration);
  const cls =
    "inline-flex shrink-0 items-center text-[15px] font-semibold tabular-nums text-white/55 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]";
  if (onCycle) {
    return (
      <button
        type="button"
        onClick={onCycle}
        title={t(cycleTitle(fmt))}
        style={TIME_FONT}
        className={`${cls} pointer-events-auto cursor-pointer transition-colors hover:text-white/95`}
      >
        {text}
        <CachedDot active={active} />
      </button>
    );
  }
  return (
    <span className={cls} style={TIME_FONT}>
      {text}
      <CachedDot active={active} />
    </span>
  );
}
