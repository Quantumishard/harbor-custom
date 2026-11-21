import { useEffect, useState } from "react";
import type { PlayerSrc } from "@/lib/view";
import { resolveLiveAnimeScrobble, type LiveAnimeProof } from "./live-scrobble";

export type LiveScrobbleResolution =
  | { phase: "off"; proof: null }
  | { phase: "resolving"; proof: null }
  | { phase: "ready"; proof: LiveAnimeProof | null };

type State = { key: string; proof: LiveAnimeProof | null };

export function useLiveScrobbleResolution({
  src, enabledSetting,
}: { src: PlayerSrc; enabledSetting: boolean }): LiveScrobbleResolution {
  const ep = src.episode;
  const relevant = Boolean(ep && (
    src.isAnime || src.meta.type === "anime" ||
    /^(?:kitsu|mal|anilist|anidb):/.test(src.meta.id) ||
    /^kitsu:[1-9]\d*:[1-9]\d*$/.test(ep.kitsuStreamId ?? "") ||
    /^(?:kitsu|mal|anilist|anidb):[1-9]\d*$/.test(ep.sourceMetaId ?? "")));
  const enabled = enabledSetting && relevant;
  const key = [
    src.meta.id, src.meta.type, src.isAnime, ep?.season, ep?.episode,
    ep?.imdbId, ep?.imdbSeason, ep?.imdbEpisode, ep?.kitsuStreamId, ep?.sourceMetaId,
  ].join("|");
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Disabling and re-enabling during the same episode must not revive a
      // proof cached under a previous database/setting state.
      setState(null);
      return;
    }
    let cancelled = false;
    // A player/episode switch invalidates its previous target immediately.
    void resolveLiveAnimeScrobble(src)
      .then((proof) => {
        if (!cancelled) setState({ key, proof });
      })
      .catch(() => {
        if (!cancelled) setState({ key, proof: null });
      });
    return () => {
      cancelled = true;
    };
    // The source key contains only meaningful playback identity dimensions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  if (!enabled) return { phase: "off", proof: null };
  if (!state || state.key !== key) return { phase: "resolving", proof: null };
  return { phase: "ready", proof: state.proof };
}
