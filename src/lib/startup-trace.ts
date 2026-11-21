/**
 * Startup instrumentation. Marks are cheap and always recorded; measures,
 * observers and persistence are opt-in so normal launches stay unaffected.
 *
 * Baseline collection:
 *   localStorage.setItem("harbor.startupTrace", "1")
 *   ...launch cold and warm several times...
 *   copy(__harborStartup.export())
 *   node scripts/startup-trace-summary.mjs trace.json
 *
 * `?startupTrace=1` enables the same output for a single launch.
 *
 * Focusability is opt-in separately with `?startupProbe=1` or
 * `harbor.startupProbe=1`. Automated interaction tests should click a primary
 * nav control and then call `__harborStartup.mark("navigation.interactive")`.
 */
export type NativeStartupTimeline = {
  processStartUnixMs: number;
  windowShownUnixMs: number | null;
  windowShownElapsedMs: number | null;
};

export type StartupMark = { name: string; at: number };

export type StartupEvent = {
  name: string;
  at: number;
  detail?: Record<string, unknown>;
};

export type StartupMeasure = { name: string; ms: number };

export type StartupLongTasks = {
  count: number;
  totalMs: number;
  longestMs: number;
  postRevealCount: number;
  postRevealTotalMs: number;
  postRevealLongestMs: number;
};

export type StartupTraceSnapshot = {
  version: 1;
  launchId: string;
  at: number;
  timeOrigin: number;
  native: NativeStartupTimeline | null;
  marks: StartupMark[];
  events: StartupEvent[];
  measures: StartupMeasure[];
  longTasks: StartupLongTasks;
  stalled?: boolean;
};

const MARK_PREFIX = "harbor:startup:";
const HISTORY_KEY = "harbor.startup.traces.v1";
const HISTORY_MAX = 20;
const POST_REVEAL_CAPTURE_MS = 15_000;
const STALLED_STARTUP_MS = 20_000;
const launchId = makeLaunchId();
const seen = new Set<string>();
const events: StartupEvent[] = [];
const MAX_EVENTS = 500;
const longTasks: StartupLongTasks = {
  count: 0,
  totalMs: 0,
  longestMs: 0,
  postRevealCount: 0,
  postRevealTotalMs: 0,
  postRevealLongestMs: 0,
};
const observers: PerformanceObserver[] = [];
let native: NativeStartupTimeline | null = null;
let nativeRequest: Promise<void> | null = null;
let finished = false;
let stalledTimer: number | null = null;
let revealedAt: number | null = null;

function makeLaunchId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* Fall back to a session-only id. */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canMark(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

export function startupMark(name: string): void {
  if (!canMark()) return;
  try {
    performance.mark(MARK_PREFIX + name);
    if (name === "root.revealed") revealedAt = performance.now();
  } catch {
    /* Instrumentation must never affect startup. */
  }
}

/** Structured, timestamped detail for stages a mark cannot describe. */
export function startupEvent(name: string, detail?: Record<string, unknown>): void {
  try {
    if (events.length >= MAX_EVENTS) return;
    const at =
      typeof performance !== "undefined" && Number.isFinite(performance.now())
        ? performance.now()
        : 0;
    events.push({ name, at, ...(detail ? { detail } : {}) });
  } catch {
    /* Instrumentation must never affect startup. */
  }
}

function startupMarkAt(name: string, startTime: number): void {
  if (!canMark() || !Number.isFinite(startTime)) return;
  try {
    performance.mark(MARK_PREFIX + name, { startTime });
  } catch {
    /* Instrumentation must never affect startup. */
  }
}

/** Startup milestones are first-wins, including under StrictMode double effects. */
export function startupMarkOnce(name: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  startupMark(name);
}

export function startupHasMark(name: string): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") {
    return false;
  }
  try {
    return performance.getEntriesByName(MARK_PREFIX + name).length > 0;
  } catch {
    return false;
  }
}

function readMarks(): StartupMark[] {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function")
    return [];
  try {
    const byName = new Map<string, number>();
    for (const entry of performance.getEntriesByType("mark") as PerformanceMark[]) {
      if (!entry.name.startsWith(MARK_PREFIX)) continue;
      const name = entry.name.slice(MARK_PREFIX.length);
      if (!byName.has(name)) byName.set(name, entry.startTime);
    }
    return [...byName].map(([name, at]) => ({ name, at })).sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

function markValue(marks: ReadonlyMap<string, number>, name: string): number | undefined {
  return marks.get(name);
}

/** Pure measure math so the trace can be tested without a browser clock. */
export function computeStartupMeasures(
  marks: ReadonlyMap<string, number>,
  nativeTimeline: NativeStartupTimeline | null,
  timeOrigin: number,
): StartupMeasure[] {
  const rows: StartupMeasure[] = [];
  const add = (
    name: string,
    from: number | undefined,
    to: number | undefined,
    clampZero = false,
  ) => {
    if (from == null || to == null) return;
    const raw = to - from;
    rows.push({
      name,
      ms: Math.round((clampZero ? Math.max(0, raw) : raw) * 10) / 10,
    });
  };
  const navigation = 0;
  add("webview.navigation→entry", navigation, markValue(marks, "webview-entry"));
  add("webview.navigation→render-called", navigation, markValue(marks, "boot.render-called"));
  add("webview.navigation→shell-committed", navigation, markValue(marks, "shell.committed"));
  add("webview.navigation→root-revealed", navigation, markValue(marks, "root.revealed"));
  add("webview.navigation→first-input", navigation, markValue(marks, "first-input"));
  add("webview.navigation→home-data-ready", navigation, markValue(marks, "home.data-ready"));
  add(
    "webview.navigation→home-rows-committed",
    navigation,
    markValue(marks, "home.rows-committed"),
  );
  add("webview.navigation→home-hero-ready", navigation, markValue(marks, "home.hero-ready"));

  add(
    "mount.start→critical-done",
    markValue(marks, "mount.start"),
    markValue(marks, "boot.critical-done"),
  );
  add(
    "mount.start→render-called",
    markValue(marks, "mount.start"),
    markValue(marks, "boot.render-called"),
  );
  add(
    "render-called→shell-committed",
    markValue(marks, "boot.render-called"),
    markValue(marks, "shell.committed"),
  );
  add(
    "shell-committed→app-ready",
    markValue(marks, "shell.committed"),
    markValue(marks, "app.ready"),
  );
  add("app-ready→root-revealed", markValue(marks, "app.ready"), markValue(marks, "root.revealed"));
  add(
    "root-revealed→first-frame",
    markValue(marks, "root.revealed"),
    markValue(marks, "root.first-frame"),
  );
  // First input can arrive before reveal. Keep the absolute timestamp above, but
  // only report a post-reveal latency when the input actually happened after it.
  const rootRevealed = markValue(marks, "root.revealed");
  const firstInput = markValue(marks, "first-input");
  if (rootRevealed != null && firstInput != null && firstInput >= rootRevealed) {
    add("root-revealed→first-input", rootRevealed, firstInput);
  }
  add(
    "root-revealed→splash-removed",
    markValue(marks, "root.revealed"),
    markValue(marks, "splash.removed"),
  );
  add(
    "root-revealed→home-data-ready",
    markValue(marks, "root.revealed"),
    markValue(marks, "home.data-ready"),
    true,
  );
  add(
    "root-revealed→home-rows-committed",
    markValue(marks, "root.revealed"),
    markValue(marks, "home.rows-committed"),
    true,
  );
  add(
    "root-revealed→home-hero-ready",
    markValue(marks, "root.revealed"),
    markValue(marks, "home.hero-ready"),
    true,
  );
  add(
    "root-revealed→deferred-settled",
    markValue(marks, "root.revealed"),
    markValue(marks, "deferred.settled"),
    true,
  );
  add(
    "root-revealed→navigation-focusable",
    markValue(marks, "root.revealed"),
    markValue(marks, "navigation.focusable"),
    true,
  );
  add(
    "root-revealed→navigation-interactive",
    markValue(marks, "root.revealed"),
    markValue(marks, "navigation.interactive"),
    true,
  );

  if (nativeTimeline) {
    const processStart = nativeTimeline.processStartUnixMs || null;
    const windowShown = nativeTimeline.windowShownUnixMs;
    const windowElapsed = nativeTimeline.windowShownElapsedMs;
    if (processStart != null && windowShown != null) {
      add("native.process-start→window-shown", 0, windowElapsed ?? windowShown - processStart);
    }
    const root = markValue(marks, "root.revealed");
    if (processStart != null && root != null) {
      add("native.process-start→root-revealed", 0, timeOrigin + root - processStart);
    }
    const shell = markValue(marks, "shell.committed");
    if (windowShown != null && shell != null) {
      // The native window is shown on page-load completion, which can land after
      // the React shell commits. A negative value is meaningful, not a bug.
      add("native.window-shown→shell-committed", 0, timeOrigin + shell - windowShown);
    }
  }
  return rows;
}

export function startupSnapshot(): StartupTraceSnapshot {
  const marks = readMarks();
  const byName = new Map(marks.map((mark) => [mark.name, mark.at]));
  const timeOrigin =
    typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
      ? performance.timeOrigin
      : 0;
  return {
    version: 1,
    launchId,
    at: Date.now(),
    timeOrigin,
    native,
    marks,
    events: [...events],
    measures: computeStartupMeasures(byName, native, timeOrigin),
    longTasks: { ...longTasks },
  };
}

export function startupTraceEnabled(): boolean {
  try {
    if (
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("startupTrace") === "1"
    ) {
      return true;
    }
  } catch {
    /* Fall through to the stored flag. */
  }
  try {
    return (
      typeof localStorage !== "undefined" && localStorage.getItem("harbor.startupTrace") === "1"
    );
  } catch {
    return false;
  }
}

/** The focusability probe is explicit and separate from baseline tracing. */
export function startupProbeEnabled(): boolean {
  try {
    if (
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("startupProbe") === "1"
    ) {
      return true;
    }
  } catch {
    /* Fall through to the stored flag. */
  }
  try {
    return (
      typeof localStorage !== "undefined" && localStorage.getItem("harbor.startupProbe") === "1"
    );
  } catch {
    return false;
  }
}

export function startupTraceHistory(): StartupTraceSnapshot[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StartupTraceSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function startupTraceExport(): string {
  return JSON.stringify(
    { version: 1, current: startupSnapshot(), traces: startupTraceHistory() },
    null,
    2,
  );
}

function persistSnapshot(snapshot: StartupTraceSnapshot): void {
  try {
    const history = startupTraceHistory();
    const index = history.findIndex((trace) => trace.launchId === snapshot.launchId);
    if (index >= 0) history[index] = snapshot;
    else history.push(snapshot);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch {
    /* A full or blocked store must not affect startup. */
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined") window.setTimeout(resolve, ms);
    else resolve();
  });
}

/**
 * Fetch the native timeline again. The first request can run before the native
 * window has been shown, so startup completion refreshes it once.
 */
export function refreshNativeStartupTimeline(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve();
  }
  return import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<NativeStartupTimeline>("startup_timeline"))
    .then((timeline) => {
      // Never replace a complete timeline with an incomplete one.
      if (!native || native.windowShownUnixMs == null || timeline.windowShownUnixMs != null) {
        native = timeline;
      }
    })
    .catch(() => {
      /* A web preview or an older native build has no timeline command. */
    });
}

export function preloadNativeStartupTimeline(): Promise<void> {
  if (nativeRequest) return nativeRequest;
  nativeRequest = refreshNativeStartupTimeline();
  return nativeRequest;
}

/** A stuck splash still leaves a diagnostic trace in the history. */
export function armStalledStartupTrace(): void {
  if (typeof window === "undefined" || stalledTimer != null) return;
  stalledTimer = window.setTimeout(() => {
    stalledTimer = null;
    if (finished) return;
    const snapshot = startupSnapshot();
    snapshot.stalled = true;
    persistSnapshot(snapshot);
    try {
      console.warn(`[harbor] startup trace: still incomplete after ${STALLED_STARTUP_MS}ms`);
    } catch {
      /* Diagnostics must not affect startup. */
    }
  }, STALLED_STARTUP_MS);
}

/** First input is telemetry; long tasks show whether deferred work stutters. */
export function observeStartupPerformance(): void {
  if (!startupTraceEnabled()) return;
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  try {
    const first = new PerformanceObserver((list) => {
      const entry = list.getEntries()[0];
      if (!entry) return;
      startupMarkAt("first-input", entry.startTime);
      first.disconnect();
    });
    first.observe({ type: "first-input", buffered: true });
    observers.push(first);
  } catch {
    /* Unsupported observer type. */
  }
  try {
    const long = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.count += 1;
        longTasks.totalMs += entry.duration;
        longTasks.longestMs = Math.max(longTasks.longestMs, entry.duration);
        if (revealedAt != null && entry.startTime >= revealedAt) {
          longTasks.postRevealCount += 1;
          longTasks.postRevealTotalMs += entry.duration;
          longTasks.postRevealLongestMs = Math.max(longTasks.postRevealLongestMs, entry.duration);
        }
      }
    });
    long.observe({ type: "longtask", buffered: true });
    observers.push(long);
  } catch {
    /* Unsupported observer type. */
  }
}

export function stopStartupPerformanceObservation(): void {
  for (const observer of observers) observer.disconnect();
  observers.length = 0;
}

/**
 * Focusable is not the same as interactive. This probe is opt-in with
 * `?startupProbe=1` (or `harbor.startupProbe=1`) and is meant for automated
 * testing, never for ordinary traced launches. Automated interaction probes can
 * click a nav control and then call `__harborStartup.mark("navigation.interactive")`.
 */
export function probeNavigationFocusable(): void {
  if (!startupProbeEnabled() || typeof document === "undefined") return;
  const visible = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.getClientRects().length > 0,
    );
  const element = visible('[data-harbor-nav="home"]') ?? visible("[data-harbor-nav]");
  if (!element) return;
  element.focus({ preventScroll: true });
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (document.activeElement === element) startupMarkOnce("navigation.focusable");
      element.blur();
    }),
  );
}

/**
 * Finalize the reveal trace. If tracing is enabled, persist a bounded post-reveal
 * snapshot too; the same launch id replaces the earlier entry.
 */
export async function startupFinish(): Promise<void> {
  if (finished) return;
  finished = true;
  if (stalledTimer != null && typeof window !== "undefined") {
    window.clearTimeout(stalledTimer);
    stalledTimer = null;
  }
  if (nativeRequest) await Promise.race([nativeRequest, wait(300)]);
  if (!native || native.windowShownUnixMs == null) {
    await Promise.race([refreshNativeStartupTimeline(), wait(300)]);
  }
  const enabled = startupTraceEnabled();
  const hadStalled = startupTraceHistory().some(
    (trace) => trace.launchId === launchId && trace.stalled === true,
  );
  const snapshot = startupSnapshot();
  if (enabled) {
    try {
      console.table(snapshot.measures);
    } catch {
      /* Console output is optional. */
    }
    try {
      console.info("[harbor] startup trace", snapshot);
    } catch {
      /* Console output is optional. */
    }
  }
  if (enabled || hadStalled) persistSnapshot(snapshot);
  if (enabled && typeof window !== "undefined") {
    window.setTimeout(() => {
      if (!startupTraceEnabled()) {
        stopStartupPerformanceObservation();
        return;
      }
      void Promise.race([refreshNativeStartupTimeline().catch(() => {}), wait(300)])
        .then(() => persistSnapshot(startupSnapshot()))
        .finally(() => stopStartupPerformanceObservation());
    }, POST_REVEAL_CAPTURE_MS);
  } else {
    stopStartupPerformanceObservation();
  }
}

/** Test/manual reset. Never called during a normal launch. */
export function resetStartupTrace(): void {
  seen.clear();
  events.length = 0;
  native = null;
  nativeRequest = null;
  finished = false;
  longTasks.count = 0;
  longTasks.totalMs = 0;
  longTasks.longestMs = 0;
  longTasks.postRevealCount = 0;
  longTasks.postRevealTotalMs = 0;
  longTasks.postRevealLongestMs = 0;
  revealedAt = null;
  stopStartupPerformanceObservation();
  if (stalledTimer != null && typeof window !== "undefined") {
    window.clearTimeout(stalledTimer);
  }
  stalledTimer = null;
  try {
    for (const entry of performance.getEntriesByType("mark") as PerformanceMark[]) {
      if (entry.name.startsWith(MARK_PREFIX)) performance.clearMarks(entry.name);
    }
  } catch {
    /* Best effort. */
  }
}

const api = {
  mark: startupMark,
  markOnce: startupMarkOnce,
  event: startupEvent,
  snapshot: startupSnapshot,
  report: () => startupSnapshot().measures,
  finish: startupFinish,
  history: startupTraceHistory,
  export: startupTraceExport,
  reset: resetStartupTrace,
};

declare global {
  interface Window {
    __harborStartup?: typeof api;
  }
}

if (typeof window !== "undefined") {
  window.__harborStartup = api;
}
