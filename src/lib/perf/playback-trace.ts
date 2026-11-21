import { dlog } from "@/lib/debug";
import { tracePlayback } from "@/lib/player/pause-trace";

// Dotted resume labels avoid the privacy scrubber's long-token rule.
export type PlaybackMilestone =
  | "resolve-start"
  | "resolve-ready"
  | "resume-start"
  | "resume-ready"
  | "resume.position-pending"
  | "resume.position-confirmed"
  | "redirect-start"
  | "redirect-ready"
  | "preflight-start"
  | "preflight-ready"
  | "player-opened"
  | "loader-shown"
  | "bridge-load"
  | "bridge-prepared"
  | "reuse-prepare-start"
  | "reuse-prepare-ready"
  | "reuse-fallback"
  | "mpv-start-requested"
  | "loadfile-requested"
  | "loadfile-accepted"
  | "file-loaded"
  | "first-frame";

type ActiveTrace = {
  startedAt: number;
  lastAt: number;
  lastStage: string;
  lines: string[];
  nativeReady: boolean;
  milestones: Set<PlaybackMilestone>;
  times: Map<PlaybackMilestone, number>;
  timer: ReturnType<typeof setInterval>;
  sourceClass: "direct" | "debrid" | "p2p" | "unknown";
};

const active = new Map<string, ActiveTrace>();
let nextTraceId = 0;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function markName(traceId: string, milestone: string): string {
  return `harbor:playback:${traceId}:${milestone}`;
}

export function beginPlaybackTrace(sourceClass: ActiveTrace["sourceClass"]): string {
  const traceId = `${Date.now().toString(36)}-${(++nextTraceId).toString(36)}`;
  const startedAt = now();
  const timer = setInterval(() => {
    const trace = active.get(traceId);
    if (!trace) return;
    // Bounded diagnostics even if a caller never reports cancellation.
    if (now() - trace.startedAt > 300_000) {
      finishPlaybackTrace(traceId, "trace-expired");
      return;
    }
    writeTrace(
      traceId,
      trace,
      `waiting stage=${trace.lastStage} elapsed_ms=${Math.round(now() - trace.startedAt)} stage_ms=${Math.round(now() - trace.lastAt)}`,
    );
  }, 10_000);
  active.set(traceId, {
    startedAt,
    lastAt: startedAt,
    lastStage: "committed",
    sourceClass,
    lines: [],
    nativeReady: false,
    milestones: new Set(),
    times: new Map(),
    timer,
  });
  performance?.mark?.(markName(traceId, "committed"));
  writeTrace(traceId, active.get(traceId)!, `committed source=${sourceClass}`);
  return traceId;
}

export function markPlaybackTrace(
  traceId: string | null | undefined,
  milestone: PlaybackMilestone,
): void {
  if (!traceId || !active.has(traceId)) return;
  const trace = active.get(traceId)!;
  if (trace.milestones.has(milestone)) return;
  trace.milestones.add(milestone);
  performance?.mark?.(markName(traceId, milestone));
  const at = now();
  trace.times.set(milestone, at);
  const spanStart =
    milestone === "resume.position-confirmed"
      ? trace.times.get("resume.position-pending")
      : milestone === "resume-ready"
        ? trace.times.get("resume-start")
        : milestone === "resolve-ready"
          ? trace.times.get("resolve-start")
          : milestone === "redirect-ready"
            ? trace.times.get("redirect-start")
            : milestone === "first-frame"
              ? (trace.times.get("mpv-start-requested") ?? trace.times.get("loadfile-requested"))
              : undefined;
  const duration = spanStart === undefined ? "" : ` duration_ms=${Math.round(at - spanStart)}`;
  const previous = trace.lastStage;
  const stepMs = Math.round(at - trace.lastAt);
  // UI visibility is an observation, not a new startup operation.
  if (milestone !== "loader-shown") {
    trace.lastAt = at;
    trace.lastStage = milestone;
  }
  if (milestone === "loadfile-accepted" || milestone === "file-loaded") {
    trace.nativeReady = true;
    for (const line of trace.lines) tracePlayback(line);
    trace.lines = [];
  }
  writeTrace(
    traceId,
    trace,
    `${milestone} elapsed_ms=${Math.round(at - trace.startedAt)} since=${previous} step_ms=${stepMs}${duration}`,
  );
  if (milestone === "resume.position-confirmed" && trace.milestones.has("first-frame")) {
    finishPlaybackTrace(traceId);
  }
}

export function finishPlaybackTrace(
  traceId: string | null | undefined,
  outcome: "ready" | "failed" | "aborted" | "replaced" | "trace-expired" = "ready",
): void {
  if (!traceId) return;
  const trace = active.get(traceId);
  if (!trace) return;
  // First frame can precede a resume prompt or its resulting seek.
  if (
    outcome === "ready" &&
    trace.milestones.has("resume.position-pending") &&
    !trace.milestones.has("resume.position-confirmed")
  )
    return;
  const end = markName(traceId, outcome);
  performance?.mark?.(end);
  try {
    performance?.measure?.(markName(traceId, "total"), {
      start: markName(traceId, "committed"),
      end,
    });
  } catch {
    // Performance marks are diagnostic only and must never affect playback.
  }
  writeTrace(
    traceId,
    trace,
    `${outcome} source=${trace.sourceClass} total_ms=${Math.round(now() - trace.startedAt)}`,
  );
  clearInterval(trace.timer);
  active.delete(traceId);
}

function writeTrace(traceId: string, trace: ActiveTrace, message: string): void {
  // Only generated IDs, fixed stage names and timings enter this log.
  const line = `[perf][playback] ${traceId} ${message}`;
  dlog(line);
  if (trace.nativeReady) tracePlayback(line);
  else if (trace.lines.length < 64) trace.lines.push(line);
}
