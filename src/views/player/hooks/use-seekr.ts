import { useEffect } from "react";
import { seekrStart, seekrStop, useSeekrState, type SeekrStartInput } from "@/lib/seekr";

export function useSeekr({
  apiKey,
  metaId,
  imdbId,
  imdbIdVerified,
  type,
  episode,
  durationSec,
  enabled,
  isLive,
}: SeekrStartInput & {
  enabled: boolean;
  isLive: boolean;
}) {
  const state = useSeekrState();

  useEffect(() => {
    if (!enabled || isLive || !apiKey.trim() || durationSec <= 0) {
      seekrStop();
      return;
    }
    const timer = window.setTimeout(() => {
      void seekrStart({ apiKey, metaId, imdbId, imdbIdVerified, type, episode, durationSec });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [apiKey, metaId, imdbId, imdbIdVerified, type, episode, durationSec, enabled, isLive]);

  useEffect(() => () => seekrStop(), []);

  return state;
}
