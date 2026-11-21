import { useEffect, useMemo, useState } from "react";

import { animeCwIdsVersion, getAnimeCwId, subscribeAnimeCwIds } from "@/lib/anime-cw-ids";
import { identityFlags } from "./flags";
import {
  applyVerifiedCwRepairs,
  subscribeVerifiedCwRepairs,
  verifiedCwRepairVersion,
  warmVerifiedCwRepairs,
} from "./cw-repair";
import {
  groupCwCards,
  identityCardsVersion,
  subscribeIdentityCards,
  warmIdentityCards,
} from "./card-grouping";

type CardRow = {
  _id: string;
  _mtime?: string;
  type?: string;
  isAnime?: boolean;
  state?: { season?: number; episode?: number; video_id?: string; lastWatched?: string };
  cwMembers?: CardRow[];
};

/**
 * Display-side card grouping. Flag off → input untouched. With the flag on,
 * rows are warmed asynchronously; one re-render follows when card keys are
 * known.
 *
 * Never retire an entry solely from provider season numbering: Black Clover,
 * BLEACH and Gintama can span multiple native works. An optional, separate
 * display-only repair requires verified episode evidence and a unique owner;
 * original playback and sync records are never rewritten or removed.
 */
export function useIdentityCardGrouping<T extends CardRow>(items: T[], repairEnabled = false): T[] {
  const [cardsVersion, setCardsVersion] = useState(() => identityCardsVersion());
  const [repairVersion, setRepairVersion] = useState(() => verifiedCwRepairVersion());
  const [aliasVersion, setAliasVersion] = useState(() => animeCwIdsVersion());

  useEffect(() => subscribeIdentityCards(() => setCardsVersion(identityCardsVersion())), []);
  useEffect(() => subscribeVerifiedCwRepairs(() => setRepairVersion(verifiedCwRepairVersion())), []);
  useEffect(() => subscribeAnimeCwIds(() => setAliasVersion(animeCwIdsVersion())), []);

  useEffect(() => {
    if (!identityFlags().cards) return;
    const probes = (rowId: string) => {
      const ids = [rowId];
      const canonical = getAnimeCwId(rowId);
      if (canonical && canonical !== rowId) ids.push(canonical);
      return ids;
    };
    void warmIdentityCards(items, probes).catch(() => {});
  }, [items, aliasVersion, cardsVersion]);

  useEffect(() => {
    if (!repairEnabled || !identityFlags().pack || !identityFlags().cards) return;
    void warmVerifiedCwRepairs(items).catch(() => {});
  }, [items, aliasVersion, repairEnabled]);

  return useMemo(() => {
    const rows = repairEnabled && identityFlags().pack && identityFlags().cards
      ? applyVerifiedCwRepairs(items)
      : items;
    return groupCwCards(rows);
  }, [items, cardsVersion, aliasVersion, repairVersion, repairEnabled]);
}
