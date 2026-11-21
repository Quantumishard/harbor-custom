import { useEffect, useState } from "react";
import { anilistAnimeEntry } from "@/lib/anilist/entry";
import { fetchAnilistMediaDetails, type AnilistMediaDetails } from "@/lib/anilist/media-details";
import { kitsuToAnilist } from "@/lib/providers/anime-mapping";

/** Resolve the explicitly opened anime before a Kitsu cross-reference. */
export async function resolveDetailAnilistId(
  canonicalId: string,
  requestedId?: string,
): Promise<number | null> {
  const direct = /^anilist:([1-9]\d*)$/.exec(requestedId ?? "");
  if (direct) return Number(direct[1]);
  const mal = /^mal:([1-9]\d*)$/.exec(requestedId ?? "");
  if (mal) {
    const entry = await anilistAnimeEntry(Number(mal[1]), "mal").catch(() => null);
    if (entry) return entry.id;
  }
  const anilist = /^anilist:([1-9]\d*)$/.exec(canonicalId);
  if (anilist) return Number(anilist[1]);
  const kitsu = /^kitsu:([1-9]\d*)$/.exec(canonicalId);
  return kitsu ? kitsuToAnilist(Number(kitsu[1])).catch(() => null) : null;
}

export function useAnimeAnilistDetails(
  canonicalId: string | null,
  isAnime: boolean,
  requestedId?: string,
): AnilistMediaDetails | null {
  const [details, setDetails] = useState<AnilistMediaDetails | null>(null);

  useEffect(() => {
    if (!isAnime || !canonicalId) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<AnilistMediaDetails | null> => {
      const anilistId = await resolveDetailAnilistId(canonicalId, requestedId);
      return anilistId != null ? fetchAnilistMediaDetails(anilistId) : null;
    };
    setDetails(null);
    load()
      .then((res) => {
        if (!cancelled) setDetails(res);
      })
      .catch(() => {
        if (!cancelled) setDetails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canonicalId, isAnime, requestedId]);

  return details;
}
