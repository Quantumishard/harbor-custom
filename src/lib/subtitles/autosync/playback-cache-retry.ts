/** Retry only transient playback-cache capture failures, never an unverified offset. */
export const MAX_CACHE_CAPTURE_ATTEMPTS = 2;

export function cacheCaptureRetryReason(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match =
    /^cache-audio-(?:timeline-(?:discontinuous|unverified|cache-timeout|probe-failed)|incomplete)(?::[a-z-]+)?$/.exec(
      text.trim(),
    );
  return match?.[0] ?? null;
}

/** A second scene must not reuse the first scene's cached dump or anchor. */
export function cacheCaptureScenePath(originalPath: string, scene: number): string {
  if (scene === 1) return originalPath;
  if (scene !== 2) throw new RangeError("Invalid playback scene attempt");
  if (!originalPath.endsWith(".mkv")) throw new Error("Invalid playback cache path");
  return originalPath.slice(0, -4) + "-scene-2.mkv";
}

export function cacheCaptureAttemptPath(originalPath: string, attempt: number): string {
  if (attempt < 1 || attempt > MAX_CACHE_CAPTURE_ATTEMPTS) {
    throw new RangeError("Invalid cache capture attempt");
  }
  if (attempt === 1) return originalPath;
  if (!originalPath.endsWith(".mkv")) throw new Error("Invalid playback cache path");
  return originalPath.slice(0, -4) + `-retry-${attempt}.mkv`;
}
