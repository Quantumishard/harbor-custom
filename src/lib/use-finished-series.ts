import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LibraryItem } from "./stremio";
import type { LocalEntry } from "./watchlist";
import {
  manualWatchedRawKeys,
  manualWatchedVersion,
  subscribeManualWatched,
} from "./manual-watched";
import { isWatchedFlagged, useWatchedFlagIds } from "./watched-flag";
import { isSeriesFinished, type SeriesFinishedCandidate } from "./watchlist-series-finished";

type WatchlistCardLike = {
  meta: { id: string; type: string };
  stremioId?: string;
  localId?: string;
};

function cardImdbId(
  card: WatchlistCardLike,
  local: LocalEntry | undefined,
  stremio: LibraryItem | undefined,
): string | null {
  if (local?.imdbId) return local.imdbId;
  if (stremio?._id.startsWith("tt")) return stremio._id;
  if (card.meta.id.startsWith("tt")) return card.meta.id;
  return null;
}

function candidateKey(candidate: SeriesFinishedCandidate): string {
  return `${candidate.id}|${candidate.imdbId ?? ""}`;
}

/**
 * Resolve "all released episodes watched" for Watchlist series in the
 * background. Results are cached by the resolver; this hook only schedules the
 * candidates that have some progress. Series with no progress are never
 * checked. The list remains visible until a check confirms it is finished.
 */
export function useFinishedSeries(
  cards: WatchlistCardLike[],
  locals: LocalEntry[],
  stremioItems: LibraryItem[],
  enabled: boolean,
): Set<string> {
  const flagIds = useWatchedFlagIds();
  const manualVersion = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion, () => 0);
  const [finished, setFinished] = useState<Set<string>>(() => new Set());
  const finishedRef = useRef(finished);

  const manualSeriesIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of manualWatchedRawKeys()) {
      const owner = key.slice(0, key.indexOf("|"));
      if (owner) ids.add(owner);
    }
    return ids;
  }, [manualVersion]);

  const candidates = useMemo(() => {
    if (!enabled) return [];
    const byId = new Map<string, LibraryItem>();
    for (const item of stremioItems) {
      byId.set(item._id, item);
      for (const id of item.altIds ?? []) if (!byId.has(id)) byId.set(id, item);
    }
    const out: SeriesFinishedCandidate[] = [];
    const seen = new Set<string>();
    for (const card of cards) {
      if (card.meta.type === "movie") continue;
      const local = card.localId ? locals.find((entry) => entry.id === card.localId) : undefined;
      const stremio =
        (card.stremioId ? byId.get(card.stremioId) : undefined) ??
        byId.get(card.meta.id) ??
        (local?.imdbId ? byId.get(local.imdbId) : undefined);
      const ids = [card.meta.id, card.stremioId, card.localId, local?.imdbId].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      if (ids.some((id) => isWatchedFlagged(id))) continue;
      const hasProgress =
        !!stremio?.state?.watched ||
        (stremio?.state?.flaggedWatched ?? 0) > 0 ||
        (stremio?.state?.timeOffset ?? 0) > 0 ||
        (stremio?.state?.timesWatched ?? 0) > 0 ||
        ids.some((id) => manualSeriesIds.has(id));
      if (!hasProgress) continue;
      const imdbId = cardImdbId(card, local, stremio);
      const candidate: SeriesFinishedCandidate = {
        id: card.meta.id,
        imdbId,
        type: card.meta.type === "anime" ? "anime" : "series",
        videos: local?.videos,
        stremio,
      };
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  }, [cards, locals, stremioItems, enabled, manualSeriesIds, flagIds]);

  useEffect(() => {
    if (!enabled) {
      if (finishedRef.current.size) {
        finishedRef.current = new Set();
        setFinished(finishedRef.current);
      }
      return;
    }
    if (!candidates.length) {
      if (finishedRef.current.size) {
        finishedRef.current = new Set();
        setFinished(finishedRef.current);
      }
      return;
    }

    let cancelled = false;
    const run = async () => {
      const next = new Set(finishedRef.current);
      const candidateIds = new Set<string>();
      for (const candidate of candidates) {
        candidateIds.add(candidate.id);
        if (candidate.imdbId) candidateIds.add(candidate.imdbId);
      }
      // Drop stale ids that are no longer candidates in this profile.
      for (const id of next) if (!candidateIds.has(id)) next.delete(id);

      for (let i = 0; i < candidates.length; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const results = await Promise.all(
          batch.map((candidate) => isSeriesFinished(candidate).catch(() => null)),
        );
        if (cancelled) return;
        let changed = false;
        for (let j = 0; j < batch.length; j++) {
          const candidate = batch[j];
          const result = results[j];
          if (result === true) {
            if (!next.has(candidate.id)) {
              next.add(candidate.id);
              changed = true;
            }
            if (candidate.imdbId && !next.has(candidate.imdbId)) {
              next.add(candidate.imdbId);
              changed = true;
            }
          } else if (result === false || result === null) {
            // Unknown is not evidence of finished; keep the series visible.
            if (next.delete(candidate.id)) changed = true;
            if (candidate.imdbId && next.delete(candidate.imdbId)) changed = true;
          }
        }
        if (changed) {
          finishedRef.current = new Set(next);
          setFinished(finishedRef.current);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [candidates, enabled]);

  return finished;
}
