import { startupEvent, startupHasMark } from "@/lib/startup-trace";

export type CwOutcome = "success" | "failure" | "timeout" | "cancelled";

type CohortItem = { _id: string };
type Stage = "advance" | "stale" | "resurface";

const COHORT_SIZE = 12;
const HARD_WINDOW_MS = 10_000;
const QUIET_WINDOW_MS = 750;
const CANCEL_GRACE_MS = 250;
const STRUCTURAL = new Set(["insert", "removal", "reorder", "replace", "empty"]);

let cohort: string[] = [];
let cohortSet = new Set<string>();
let captured = false;
let windowEnded = false;
let advanceSettledEventSent = false;
let visibleResolvedEventSent = false;
let outcomes = new Map<string, CwOutcome>();
let pending = new Map<Stage, number>();
let identityPending = 0;
let currentPassId = 0;
let nextPassId = 1;
let mutationCount = 0;
let lastMutationAt: number | null = null;
let hardTimer: ReturnType<typeof setTimeout> | null = null;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let revealWaitTimer: ReturnType<typeof setTimeout> | null = null;
let cancelTimer: ReturnType<typeof setTimeout> | null = null;
let firstOutcomeMarked = false;
let firstVisibleMarked = false;
let emptyMarked = false;

function clearTimers(): void {
  if (hardTimer != null) clearTimeout(hardTimer);
  if (quietTimer != null) clearTimeout(quietTimer);
  if (revealWaitTimer != null) clearTimeout(revealWaitTimer);
  if (cancelTimer != null) clearTimeout(cancelTimer);
  hardTimer = null;
  quietTimer = null;
  revealWaitTimer = null;
  cancelTimer = null;
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function counts(): { settled: number; success: number; failed: number } {
  let success = 0;
  let failed = 0;
  for (const outcome of outcomes.values()) {
    if (outcome === "success") success += 1;
    else failed += 1;
  }
  return { settled: outcomes.size, success, failed };
}

function allWorkSettled(): boolean {
  return captured && outcomes.size >= cohort.length && pending.size === 0 && identityPending === 0;
}

function maybeResolved(): void {
  if (!captured || windowEnded || visibleResolvedEventSent || !allWorkSettled()) return;
  visibleResolvedEventSent = true;
  startupEvent("cw.visible.cohort.resolved", {
    ...counts(),
    pendingStages: [],
    identityPending,
  });
}

function endWindow(reason: "quiet" | "timeout"): void {
  if (!captured || windowEnded) return;
  if (reason === "timeout") {
    for (const id of cohort) {
      if (outcomes.has(id)) continue;
      outcomes.set(id, "timeout");
      startupEvent("cw.cohort.outcome", { id, outcome: "timeout" });
    }
    if (!advanceSettledEventSent && outcomes.size >= cohort.length) {
      advanceSettledEventSent = true;
      startupEvent("cw.advance.cohort.settled", counts());
    }
  }
  if (!visibleResolvedEventSent) {
    visibleResolvedEventSent = true;
    startupEvent("cw.visible.cohort.resolved", {
      ...counts(),
      pendingStages: [...pending.keys()],
      identityPending,
      ...(reason === "timeout" ? { timedOut: true } : {}),
    });
  }
  windowEnded = true;
  clearTimers();
  const summary = counts();
  startupEvent("cw.mutation.end", {
    reason,
    mutations: mutationCount,
    lastMutationAt,
    settled: summary.settled,
    success: summary.success,
    failed: summary.failed,
    pending: cohort.length - summary.settled,
    pendingStages: [...pending.keys()],
    identityPending,
    pass: currentPassId,
  });
}

function scheduleQuietWindow(): void {
  if (!captured || windowEnded || !allWorkSettled()) return;
  // The observation window is about what changes after Home is visible.
  if (!startupHasMark("root.revealed")) {
    if (revealWaitTimer == null) {
      revealWaitTimer = setTimeout(() => {
        revealWaitTimer = null;
        scheduleQuietWindow();
      }, 250);
      unref(revealWaitTimer);
    }
    return;
  }
  if (quietTimer != null) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    endWindow("quiet");
  }, QUIET_WINDOW_MS);
  unref(quietTimer);
}

function maybeQuiet(): void {
  maybeResolved();
  if (allWorkSettled()) {
    scheduleQuietWindow();
    return;
  }
  if (quietTimer != null) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
}

function settle(id: string, outcome: CwOutcome, passId = currentPassId): void {
  if (!captured || windowEnded || !cohortSet.has(id) || outcomes.has(id)) return;
  if (passId !== currentPassId) return;
  outcomes.set(id, outcome);
  if (!firstOutcomeMarked) {
    firstOutcomeMarked = true;
    startupEvent("cw.advance.first", { id, outcome, pass: passId });
  }
  startupEvent("cw.cohort.outcome", { id, outcome, pass: passId });
  if (outcomes.size >= cohort.length && !advanceSettledEventSent) {
    advanceSettledEventSent = true;
    startupEvent("cw.advance.cohort.settled", counts());
  }
  maybeQuiet();
}

/**
 * Capture the fixed first-visible cohort on the first nonempty, rendered CW
 * commit. An empty mount does not create a permanent empty cohort.
 */
export function cwCaptureCohort(items: readonly CohortItem[]): void {
  if (captured || items.length === 0) return;
  captured = true;
  cohort = items.slice(0, COHORT_SIZE).map((item) => item._id);
  cohortSet = new Set(cohort);
  startupEvent("cw.cohort.capture", { ids: cohort });
  hardTimer = setTimeout(() => {
    hardTimer = null;
    endWindow("timeout");
  }, HARD_WINDOW_MS);
  unref(hardTimer);
}

export function cwMarkFirstVisible(): void {
  if (!captured || firstVisibleMarked) return;
  firstVisibleMarked = true;
  startupEvent("cw.first.visible", { items: cohort.length });
}

/** Cards outside the advancement candidate set need no correction. */
export function cwAdvanceCandidates(ids: readonly string[], passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  const candidates = new Set(ids);
  for (const id of cohort) {
    if (!candidates.has(id)) settle(id, "success", passId);
  }
}

export function cwAdvanceStart(): number | null {
  if (!captured || windowEnded) return null;
  if (cancelTimer != null) {
    clearTimeout(cancelTimer);
    cancelTimer = null;
  }
  const passId = nextPassId++;
  currentPassId = passId;
  pending.clear();
  pending.set("advance", passId);
  startupEvent("cw.advance.start", { cohort: cohort.length, pass: passId });
  maybeQuiet();
  return passId;
}

export function cwAdvanceComplete(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  if (pending.get("advance") === passId) pending.delete("advance");
  startupEvent("cw.advance.complete", { pass: passId });
  maybeQuiet();
}

/** Release superseded pass state without extra benchmark-only events. */
export function cwAdvanceSuperseded(passId: number | null): void {
  if (!captured || passId == null || passId !== currentPassId) return;
  for (const [stage, stagePass] of pending) {
    if (stagePass === passId) pending.delete(stage);
  }
  maybeQuiet();
}

/** A cancelled, failed or timed-out worker also releases diagnostic stages. */
export function cwAdvanceTerminate(
  passId: number | null,
  _outcome: Exclude<CwOutcome, "success">,
): void {
  cwAdvanceSuperseded(passId);
}

/** The next pass starts almost immediately; only a real unmount/cancel settles as cancelled. */
export function cwAdvanceCancel(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  if (cancelTimer != null) return;
  cancelTimer = setTimeout(() => {
    cancelTimer = null;
    if (passId !== currentPassId) return;
    for (const id of cohort) settle(id, "cancelled", passId);
    if (pending.get("advance") === passId) pending.delete("advance");
    maybeQuiet();
  }, CANCEL_GRACE_MS);
  unref(cancelTimer);
}

export function cwAdvanceOutcome(id: string, outcome: CwOutcome, passId: number | null): void {
  if (passId == null) return;
  settle(id, outcome, passId);
}

/** Fires after React commits the advanced/extra/removed state. */
export function cwStateCommit(
  detail: {
    advanced: number;
    extra: number;
    removed: number;
  },
  passId: number | null,
): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  startupEvent("cw.state.commit", { ...detail, pass: passId });
  maybeQuiet();
}

export function cwStaleStart(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  pending.set("stale", passId);
  startupEvent("cw.stale.start", { pass: passId });
  maybeQuiet();
}

export function cwStaleComplete(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  if (pending.get("stale") !== passId) return;
  pending.delete("stale");
  startupEvent("cw.stale.complete", { pass: passId });
  maybeQuiet();
}

export function cwResurfaceStart(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  pending.set("resurface", passId);
  startupEvent("cw.resurface.start", { pass: passId });
  maybeQuiet();
}

export function cwResurfaceComplete(passId: number | null): void {
  if (!captured || windowEnded || passId == null || passId !== currentPassId) return;
  if (pending.get("resurface") !== passId) return;
  pending.delete("resurface");
  startupEvent("cw.resurface.complete", { pass: passId });
  maybeQuiet();
}

export function cwAnimeWarmStart(): void {
  if (!captured || windowEnded) return;
  identityPending += 1;
  startupEvent("cw.anime.warm.start", { pending: identityPending });
  maybeQuiet();
}

export function cwAnimeWarmEnd(): void {
  if (!captured || windowEnded) return;
  identityPending = Math.max(0, identityPending - 1);
  startupEvent("cw.anime.warm.end", { pending: identityPending });
  maybeQuiet();
}

export function cwAnimeVersion(version: number): void {
  if (captured && !windowEnded) startupEvent("cw.anime.version", { version });
}

/** Record a visible-row mutation; only structural changes count. */
export function cwMutation(reason: string): void {
  if (!captured || windowEnded) return;
  const afterReveal = startupHasMark("root.revealed");
  const structural = STRUCTURAL.has(reason);
  if (afterReveal && structural) {
    mutationCount += 1;
    lastMutationAt =
      typeof performance !== "undefined" && Number.isFinite(performance.now())
        ? performance.now()
        : 0;
  }
  startupEvent("cw.mutation", {
    reason,
    afterReveal,
    counted: structural,
    count: mutationCount,
  });
  maybeQuiet();
}

export function cwMarkEmptyState(): void {
  if (emptyMarked) return;
  emptyMarked = true;
  startupEvent("cw.empty.paint");
}

/** Test/manual reset. */
export function resetCwInstrumentation(): void {
  clearTimers();
  cohort = [];
  cohortSet = new Set();
  captured = false;
  windowEnded = false;
  advanceSettledEventSent = false;
  visibleResolvedEventSent = false;
  outcomes = new Map();
  pending = new Map();
  identityPending = 0;
  currentPassId = 0;
  nextPassId = 1;
  mutationCount = 0;
  lastMutationAt = null;
  firstOutcomeMarked = false;
  firstVisibleMarked = false;
  emptyMarked = false;
}
