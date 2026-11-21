import { useSyncExternalStore } from "react";
import { readMusicPreference, writeMusicPreference } from "./preferences";

export type MusicVideoQuality = "auto" | "2160" | "1440" | "1080" | "720" | "480" | "360";
const KEY = "harbor.music.video-quality.v1";
export const MUSIC_VIDEO_QUALITIES: MusicVideoQuality[] = [
  "auto",
  "2160",
  "1440",
  "1080",
  "720",
  "480",
  "360",
];

const normalize = (value: MusicVideoQuality | null | undefined): MusicVideoQuality =>
  MUSIC_VIDEO_QUALITIES.find((entry) => entry === value) ?? "auto";

let defaultQuality = normalize(readMusicPreference(KEY) as MusicVideoQuality | null);
/** A choice made while watching one video; the next song goes back to the default. */
let sessionQuality: MusicVideoQuality | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function defaultMusicVideoQuality(): MusicVideoQuality {
  return defaultQuality;
}

export function musicVideoQuality(): MusicVideoQuality {
  return sessionQuality ?? defaultQuality;
}

/** The height cap the resolver asks for. Auto keeps the native 1080 default. */
export function musicVideoMaxHeight(
  quality: MusicVideoQuality = musicVideoQuality(),
): number | null {
  return quality === "auto" ? null : Number(quality);
}

export function setDefaultMusicVideoQuality(next: MusicVideoQuality): void {
  defaultQuality = normalize(next);
  writeMusicPreference(KEY, defaultQuality);
  notify();
}

export function setMusicVideoSessionQuality(next: MusicVideoQuality): void {
  sessionQuality = normalize(next);
  notify();
}

export function clearMusicVideoSessionQuality(): void {
  if (sessionQuality === null) return;
  sessionQuality = null;
  notify();
}

export function cycleMusicVideoQuality(): void {
  const at = MUSIC_VIDEO_QUALITIES.indexOf(musicVideoQuality());
  setMusicVideoSessionQuality(MUSIC_VIDEO_QUALITIES[(at + 1) % MUSIC_VIDEO_QUALITIES.length]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMusicVideoQuality(): MusicVideoQuality {
  return useSyncExternalStore(subscribe, musicVideoQuality, musicVideoQuality);
}

export function useDefaultMusicVideoQuality(): MusicVideoQuality {
  return useSyncExternalStore(subscribe, defaultMusicVideoQuality, defaultMusicVideoQuality);
}
