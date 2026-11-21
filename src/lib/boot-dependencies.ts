import { startupMarkOnce } from "@/lib/startup-trace";

export type BootDependency = "features" | "secrets" | "themes" | "locale" | "music";

export type BootDependencyState = "ok" | "timed-out" | "failed" | "fallback";

const states = new Map<BootDependency, BootDependencyState>();

export function bootDependencyReport(): Partial<Record<BootDependency, BootDependencyState>> {
  return Object.fromEntries(states) as Partial<Record<BootDependency, BootDependencyState>>;
}

function setState(dependency: BootDependency, state: BootDependencyState): void {
  states.set(dependency, state);
  startupMarkOnce(`boot.${dependency}.${state}`);
}

export type BootWatchdogResult<T> = {
  value: T | undefined;
  timedOut: boolean;
  failed: boolean;
};

/**
 * Bound one startup dependency. A timed-out promise keeps running and is
 * allowed to reconcile through its store, but this watchdog state stays
 * terminal so a late result cannot change the boot decision. Secrets are the
 * exception: their late success is reconciled through SECRETS_READY by the
 * recovery screen.
 */
export function withBootWatchdog<T>(
  dependency: BootDependency,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<BootWatchdogResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setState(dependency, "timed-out");
      resolve({ value: undefined, timedOut: true, failed: false });
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState(dependency, "ok");
        resolve({ value, timedOut: false, failed: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState(dependency, "failed");
        resolve({ value: undefined, timedOut: false, failed: true });
      },
    );
  });
}

/** Record that a timed-out optional dependency continued with its fallback. */
export function markBootFallback(dependency: BootDependency): void {
  setState(dependency, "fallback");
}

/** Test/manual reset. */
export function resetBootDependencies(): void {
  states.clear();
}
