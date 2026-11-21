import { invoke } from "@tauri-apps/api/core";

export type SoloistStatus = {
  preferredEngine: "librespot" | "soloist";
  executablePath: string | null;
  keyConfigured: boolean;
  activeInHarbor: boolean;
  activePlaybackEngine: "soloist" | "librespot" | null;
  activePlaybackLive: boolean;
  running: boolean;
  apiReady: boolean;
  loggedIn: boolean;
  deviceName: string | null;
  error: string | null;
  visualizerError: string | null;
};

export function soloistStatus(): Promise<SoloistStatus> {
  return invoke<SoloistStatus>("music_soloist_status");
}

export function configureSoloist(executablePath?: string, apiKey?: string): Promise<void> {
  return invoke("music_soloist_configure", {
    executablePath: executablePath || null,
    apiKey: apiKey === undefined ? null : apiKey,
  });
}

export function setSoloistPreference(
  engine: SoloistStatus["preferredEngine"],
  remoteDeviceConfirmation?: string,
): Promise<void> {
  return invoke("music_soloist_set_engine", { engine, remoteDeviceConfirmation: remoteDeviceConfirmation ?? null });
}

export function startSoloist(): Promise<SoloistStatus> {
  return invoke<SoloistStatus>("music_soloist_start");
}

export function stopSoloist(): Promise<void> {
  return invoke("music_soloist_stop");
}
