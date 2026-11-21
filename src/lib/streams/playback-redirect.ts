import { invoke } from "@tauri-apps/api/core";
import { loadInstalled } from "@/lib/addon-store";

// A host that returned no usable redirect is skipped for the rest of the app
// session; repeating the probe would only add latency to every playback.
const unresolvedHosts = new Set<string>();

// Configured add-ons already receive the app's requests, so their hosts are
// the only ones worth probing with an extra range GET.
function installedAddonHosts(): Set<string> {
  const hosts = new Set<string>();
  try {
    for (const addon of loadInstalled()) {
      try {
        hosts.add(new URL(addon.transportUrl).hostname);
      } catch {}
    }
  } catch {
    // No storage (tests or web): leave the optimization off.
  }
  return hosts;
}

export function isPlaybackRedirectCandidate(
  url: string,
  addonHosts: ReadonlySet<string> = installedAddonHosts(),
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      addonHosts.has(parsed.hostname) &&
      !unresolvedHosts.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Resolve a selected add-on redirect once so mpv's range seeks go straight to the file. */
export async function resolvePlaybackRedirect({
  url,
  headers,
  signal,
}: {
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}): Promise<string> {
  if (
    signal.aborted ||
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window) ||
    (headers && Object.keys(headers).length > 0)
  ) {
    return url;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (!isPlaybackRedirectCandidate(url)) return url;
  try {
    const resolved = await invoke<string | null>("resolve_playback_redirect", { url });
    if (signal.aborted) return url;
    if (resolved) {
      const target = new URL(resolved);
      if (target.protocol === "https:" && !target.username && !target.password) return resolved;
    }
    unresolvedHosts.add(host);
    return url;
  } catch {
    // Older native builds, unavailable providers and non-file responses keep
    // the existing mpv path. No resolved signed link is cached or persisted here.
    return url;
  }
}
