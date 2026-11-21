import { anilistAnimeEntry } from "./entry";
import { fetchAnilistNextAiring, type AnilistNextAiring } from "./next-airing";
import { getAnimeCwId } from "@/lib/anime-cw-ids";
import { kitsuToAnilist } from "@/lib/providers/anime-mapping";
import { parseKitsuId } from "@/lib/providers/kitsu";

/** Resolve whatever id a Continue Watching card carries to its AniList entry. */
export async function anilistIdForCwItem(id: string): Promise<number | null> {
  const cwId = getAnimeCwId(id) ?? null;
  const candidates = cwId && cwId !== id ? [id, cwId] : [id];
  for (const candidate of candidates) {
    const anilist = /^anilist:([1-9]\d*)$/.exec(candidate);
    if (anilist) return Number(anilist[1]);

    const mal = /^mal:([1-9]\d*)$/.exec(candidate);
    if (mal) {
      const entry = await anilistAnimeEntry(Number(mal[1]), "mal").catch(() => null);
      if (entry) return entry.id;
      continue;
    }

    const kitsu = parseKitsuId(candidate);
    if (kitsu != null) {
      const anilistId = await kitsuToAnilist(kitsu).catch(() => null);
      if (anilistId != null) return anilistId;
    }
  }
  return null;
}

/** Next known AniList airing for a card, used to correct timer-mode countdowns. */
export async function fetchCwNextAiring(id: string): Promise<AnilistNextAiring | null> {
  const anilistId = await anilistIdForCwItem(id).catch(() => null);
  if (anilistId == null) return null;
  return fetchAnilistNextAiring(anilistId).catch(() => null);
}
