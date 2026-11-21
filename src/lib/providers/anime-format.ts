import type { Meta } from "@/lib/cinemeta";

export type AnimeArtworkKind = "movie" | "tv";

export function animeArtworkKind(meta: Pick<Meta, "type" | "animeFormat">): AnimeArtworkKind {
  return meta.type === "movie" || meta.animeFormat?.toUpperCase() === "MOVIE" ? "movie" : "tv";
}

export const DERIVED_ANILIST_FORMATS = new Set(["SPECIAL", "OVA", "ONA", "MUSIC"]);

export function isDerivedAnimeFormat(format?: string): boolean {
  return format != null && DERIVED_ANILIST_FORMATS.has(format.toUpperCase());
}
