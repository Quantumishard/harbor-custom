import { useCallback, useEffect, useSyncExternalStore, type RefObject } from "react";
import { observeSettled } from "@/lib/visibility";
import {
  animeHasDub,
  ensureDubSet,
  ensureDubForAnimeId,
  subscribeDubSet,
} from "@/lib/providers/anime-dub-sub";

/** Shared DUB lookup for poster cards, TV cards, and Big Picture metadata. */
export function useAnimeDub(
  metaId: string | undefined,
  enabled: boolean,
  cardRef?: RefObject<HTMLElement | null>,
  malId?: number,
): boolean {
  const readBadge = useCallback(
    () => enabled && (animeHasDub(malId ? `mal:${malId}` : undefined) || animeHasDub(metaId)),
    [enabled, malId, metaId],
  );
  const hasDub = useSyncExternalStore(subscribeDubSet, readBadge);
  useEffect(() => {
    if (!enabled || hasDub) return;
    ensureDubSet();
    if (!metaId?.startsWith("kitsu:")) return;
    const card = cardRef?.current;
    if (card) {
      return observeSettled(card, () => {
        if (!readBadge()) ensureDubForAnimeId(metaId);
      });
    }
    ensureDubForAnimeId(metaId);
  }, [cardRef, enabled, hasDub, metaId, readBadge]);
  return hasDub;
}
