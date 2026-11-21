import type { MusicCatalogItem, MusicCatalogRow } from "./types";

const LIKED_ROW_IDS = new Set(["ytm:home:liked", "ytm:library:liked"]);

/**
 * The Liked row previews tracks, but the full list lives in YouTube Music's fixed liked
 * playlist. "View all" opens that playlist; its detail page pages the remaining songs.
 */
export function ytmLikedPlaylist(
  row: MusicCatalogRow | undefined,
  title: string,
): MusicCatalogItem | null {
  if (!row || !LIKED_ROW_IDS.has(row.id)) return null;
  const artwork = row.items.find(
    (item): item is Extract<MusicCatalogItem, { kind: "track" }> =>
      item.kind === "track" && Boolean(item.artwork),
  )?.artwork;
  return {
    kind: "playlist",
    id: "VLLM",
    connectorId: "youtube",
    name: title,
    artwork: artwork ? [artwork] : [],
  };
}
