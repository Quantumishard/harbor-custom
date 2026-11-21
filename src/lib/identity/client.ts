export type IdentityInvoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let injected: IdentityInvoker | null = null;

/** Test/dev seam: bypass Tauri entirely. */
export function setIdentityInvoker(invoker: IdentityInvoker | null): void {
  injected = invoker;
}

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Invoke a Rust identity command. Returns null when Tauri is unavailable or the
 * command fails, so callers always fall back to today's behavior instead of
 * throwing on a render path.
 */
export async function invokeIdentity<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (injected) {
    try {
      return (await injected(command, args)) as T;
    } catch {
      return null;
    }
  }
  if (!tauriAvailable()) return null;
  try {
    const core = await import("@tauri-apps/api/core");
    return await core.invoke<T>(command, args);
  } catch {
    return null;
  }
}
