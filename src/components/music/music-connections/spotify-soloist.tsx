import { useCallback, useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmAction } from "@/lib/confirm-action";
import { spotifyPlaybackTarget } from "@/lib/music/spotify-devices";
import { openUrl } from "@/lib/window";
import { ChevronDown } from "@/components/icons/music-icons";
import {
  configureSoloist,
  setSoloistPreference,
  soloistStatus,
  startSoloist,
  stopSoloist,
  type SoloistStatus,
} from "@/lib/music/soloist";

const DOWNLOAD_URL = "https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates";
const KEY_URL = "https://developer.spotify.com/dashboard";
const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-full border border-edge px-4 text-[12px] font-medium text-ink transition-colors duration-200 ease-out hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
const FIELD = "h-11 w-full min-w-0 rounded-md border border-edge bg-canvas px-3 text-[13px] text-ink placeholder:text-ink-subtle transition-colors duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";
const LABEL = "block text-[12px] font-medium leading-5 text-ink-muted";
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Windows canonicalization can add a \\?\ prefix. Keep the stored path
// untouched and only show the familiar Win32 form in the editable field.
function displayExecutablePath(value: string): string {
  if (!value.startsWith("\\\\?\\")) return value;
  const remainder = value.slice(4);
  if (remainder.toUpperCase().startsWith("UNC\\")) return "\\\\" + remainder.slice(4);
  return /^[A-Za-z]:\\/.test(remainder) ? remainder : value;
}

/**
 * Opt-in local Spotify engine selector, independent of Spotify browsing and
 * explicitly selected remote Spotify Connect targets.
 */
export function SpotifySoloistSetup({
  renderLibrespotSetup,
  renderAfterSetup,
}: {
  renderLibrespotSetup?: () => ReactNode;
  renderAfterSetup?: (engine: SoloistStatus["preferredEngine"] | null) => ReactNode;
}) {
  const [status, setStatus] = useState<SoloistStatus | null>(null);
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [engineMessage, setEngineMessage] = useState("");
  const [engineError, setEngineError] = useState("");

  const refresh = useCallback(async () => {
    const next = await soloistStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let mounted = true;
    void soloistStatus().then((next) => {
      if (!mounted) return;
      setStatus(next);
      setPath(displayExecutablePath(next.executablePath ?? ""));
    }).catch((cause) => {
      if (mounted) setError(reason(cause));
    });
    return () => { mounted = false; };
  }, []);

  // Keep the notice accurate when the next track really starts on the selected
  // engine, including when Soloist is not running yet.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (action: () => Promise<unknown>, message = "") => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
      await refresh();
      setSuccess(message);
    } catch (cause) {
      setError(reason(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectEngine = async (engine: SoloistStatus["preferredEngine"]) => {
    if (busy || !status) return;
    setBusy(true);
    setEngineError("");
    try {
      const remote = await spotifyPlaybackTarget();
      if (!remote && status.preferredEngine === engine) return;
      if (remote) {
        const accepted = await confirmAction({
          title: "Switch Spotify playback output",
          message: "Switching to local playback may pause music on the selected Spotify Connect device. Continue?",
          confirmLabel: "Switch to this device",
        });
        if (!accepted) return;
      }
      // The backend re-checks the selected device. A stale confirmation
      // cannot silently interrupt a different Spotify Connect target.
      await setSoloistPreference(engine, remote ?? undefined);
      await refresh();
      setEngineMessage(remote
        ? "Output switched to this device. Playback on the previous Spotify device may have paused."
        : "");
      window.dispatchEvent(new Event("harbor:spotify-playback-target-changed"));
    } catch (cause) {
      setEngineError(reason(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = () => act(async () => {
    await configureSoloist(path.trim() || undefined, key.trim() || undefined);
    setKey("");
  }, "Soloist settings saved.");

  const selectFile = async () => {
    try {
      const selected = await open({ multiple: false, directory: false, title: "Choose Spotify Soloist executable" });
      if (typeof selected === "string") setPath(displayExecutablePath(selected));
    } catch (cause) {
      setError(reason(cause));
    }
  };

  return (
    <>
      <section className="border-t border-edge-soft bg-elevated/25 px-5 py-4">
        <h4 className="text-[13px] font-semibold leading-6 text-ink">Spotify playback engine</h4>
        <p className="mt-1 max-w-3xl text-[12px] leading-5 text-ink-muted">
          Choose how Harbor plays Spotify on this device. Changes take effect on the next track. If a remote Spotify Connect device is selected, Harbor asks before changing its output. Your Librespot pairing is retained.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(["soloist", "librespot"] as const).map((engine) => (
            <button
              key={engine}
              type="button"
              disabled={busy || !status}
              onClick={() => void selectEngine(engine)}
              aria-pressed={status?.preferredEngine === engine}
              className={`min-h-11 rounded-lg border px-3 py-2.5 text-left text-[13px] transition-colors duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 ${
                status?.preferredEngine === engine ? "border-edge bg-elevated font-semibold text-ink" : "border-edge-soft bg-canvas/30 text-ink-muted hover:border-edge hover:bg-elevated/60 hover:text-ink"
              }`}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span>{engine === "librespot" ? "Librespot" : "Soloist"}</span>
                {engine === "soloist" && (
                  <span className="rounded-full border border-edge-soft bg-elevated/50 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                    Recommended
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        {status?.activePlaybackLive && status.activePlaybackEngine &&
          status.activePlaybackEngine !== status.preferredEngine && (
          <p className="mt-3 text-[12px] leading-5 text-ink-muted" role="status" aria-live="polite">
            Currently playing through {status.activePlaybackEngine === "soloist" ? "Soloist" : "Librespot"}.
            {" "}Switches on next track.
          </p>
        )}
        {status?.preferredEngine === "soloist" && (
          <p className="mt-2 text-[12px] leading-5 text-ink-muted">
            Harbor uses Soloist's single-track mode for local playback so Harbor's queue stays in
            control. This playback instance won't appear as a separate Spotify Connect device.
          </p>
        )}
        {engineMessage && <p className="mt-2 text-[12px] leading-5 text-ink-muted" role="status">{engineMessage}</p>}
        {engineError && <p className="mt-2 text-[12px] leading-5 text-danger" role="alert">{engineError}</p>}
      </section>
      {status?.preferredEngine === "soloist" && (
      <section className="border-t border-edge-soft bg-elevated/25 px-5 py-4">
        <details className="group mt-3" open={status?.preferredEngine === "soloist" ? true : undefined}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 text-[13px] font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Configure Spotify Soloist
            <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <p className="mt-3 max-w-3xl text-[12px] leading-5 text-ink-muted">
            Spotify requires every listener to download Soloist and generate their own API key. Harbor does not ship its executable.
            Initial pairing requires a Premium account. After starting, select <strong>Harbor Soloist</strong> from Spotify Connect in the official Spotify app on the same network.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12px]">
            <button type="button" className="font-medium text-ink-muted underline decoration-edge underline-offset-4 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => void openUrl(DOWNLOAD_URL)}>Official Soloist downloads</button>
            <button type="button" className="font-medium text-ink-muted underline decoration-edge underline-offset-4 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => void openUrl(KEY_URL)}>Spotify developer dashboard</button>
          </div>
          <div className="mt-4 grid gap-3">
            <label className="music-connect-field grid gap-1.5">
              <span className={LABEL}>Extracted Soloist executable</span>
              <span className="flex gap-2">
                <input className={FIELD} value={path} onChange={(e) => setPath(e.target.value)} placeholder="Path to soloist.exe / soloist" dir="ltr" spellCheck={false} title={path} />
                <button type="button" disabled={busy} onClick={() => void selectFile()} className={BUTTON}>Browse</button>
              </span>
            </label>
            <label className="music-connect-field grid gap-1.5">
              <span className={LABEL}>Personal Soloist API key {status?.keyConfigured ? "(saved; enter a new key only to replace)" : ""}</span>
              <input
                className={FIELD}
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={status?.keyConfigured ? "Key stored securely" : "Paste your personal Soloist API key"}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy || status?.running} className={BUTTON} onClick={() => void save()}>
                Save setup
              </button>
              {status?.running ? (
                <button type="button" disabled={busy} className={BUTTON} onClick={() => void act(stopSoloist)}>
                  Stop Soloist
                </button>
              ) : (
                <button type="button" disabled={busy || !status?.keyConfigured || !status.executablePath} className={BUTTON}
                  onClick={() => void act(startSoloist)}>
                  Start pairing mode
                </button>
              )}
              <button type="button" disabled={busy} className={BUTTON} onClick={() => void act(refresh)}>
                Refresh status
              </button>
            </div>
            <p role="status" aria-live="polite" className="mt-1 flex items-center gap-2 text-[12px] leading-5 text-ink-muted">
              <span aria-hidden="true" className={status?.running && status.loggedIn ? "size-1.5 shrink-0 rounded-full bg-accent" : "size-1.5 shrink-0 rounded-full bg-ink-subtle"} />
              {status?.activeInHarbor ? "Harbor is using Soloist" : !status ? "Checking Soloist..." :
                !status.running && status.preferredEngine === "soloist" && status.keyConfigured && status.executablePath
                  ? "Idle — starts automatically when Harbor plays a song" :
                !status.running ? "Not running" :
                !status.apiReady ? "Starting / local API unavailable" :
                status.loggedIn ? `Paired - ${status.deviceName || "Harbor Soloist"}` :
                  "Running - open Spotify Connect to finish pairing"}
            </p>
            {status?.error && <p className="text-[12px] text-ink-muted">{status.error}</p>}
            {status?.visualizerError && (
              <p role="status" className="text-[12px] text-ink-muted">
                Soloist visualizer unavailable: {status.visualizerError}
              </p>
            )}
            {success && <p role="status" className="text-[12px] text-ink-muted">{success}</p>}
            {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          </div>
        </details>
      </section>
      )}
      {status?.preferredEngine === "librespot" && renderLibrespotSetup?.()}
      {renderAfterSetup?.(status?.preferredEngine ?? null)}
    </>
  );
}
