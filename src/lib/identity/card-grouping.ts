import { flattenCwSourceMembers } from "@/lib/cw-members";
import { fetchCardHints } from "./hints";
import { identityEnabled, identityFlags } from "./flags";
import type { IdentityCardHint } from "./types";

type CardRow = {
  _id: string;
  state?: { lastWatched?: string };
  _mtime?: string | number;
  cwMembers?: unknown;
};

const CARD_TTL_MS = 6 * 60 * 60_000;
const CARD_STORE_KEY = "harbor.identity.cardkeys.v1";
const cardCache = new Map<string, { at: number; key: string | null }>();
const listeners = new Set<() => void>();
let version = 0;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Card keys are stable across reloads (they only change on a weekly pack
 * refresh), so hydrate them synchronously. Without this the first row render
 * shows an ungrouped duplicate for a moment, then the warmed result replaces it.
 */
function hydrateCardCache(): void {
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(CARD_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      entries?: Record<string, { at?: number; key?: string | null }>;
    };
    const now = Date.now();
    for (const [id, entry] of Object.entries(parsed.entries ?? {})) {
      if (typeof entry?.at !== "number" || now - entry.at > CARD_TTL_MS) continue;
      cardCache.set(id, { at: entry.at, key: entry.key ?? null });
    }
  } catch {
    // A broken cache is not worth failing the row over.
  }
}

function persistCardCache(): void {
  const store = storage();
  if (!store) return;
  try {
    const now = Date.now();
    const entries: Record<string, { at: number; key: string | null }> = {};
    for (const [id, entry] of cardCache) {
      if (now - entry.at > CARD_TTL_MS) continue;
      entries[id] = entry;
    }
    store.setItem(CARD_STORE_KEY, JSON.stringify({ entries }));
  } catch {
    // Storage can be full or unavailable; grouping still works in memory.
  }
}

hydrateCardCache();

function notify(): void {
  version += 1;
  persistCardCache();
  for (const listener of listeners) listener();
}

/** Synchronous card key for a row, populated by warmIdentityCards. */
export function identityCardKey(rowId: string): string | null {
  const hit = cardCache.get(rowId);
  if (!hit) return null;
  if (Date.now() - hit.at > CARD_TTL_MS) {
    cardCache.delete(rowId);
    return null;
  }
  return hit.key;
}

export function subscribeIdentityCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearIdentityCardCache(): void {
  cardCache.clear();
  try {
    storage()?.removeItem(CARD_STORE_KEY);
  } catch {}
  notify();
}

export function identityCardsVersion(): number {
  return version;
}

function stamp(row: CardRow): number {
  const watched = Date.parse(row.state?.lastWatched ?? "");
  if (Number.isFinite(watched)) return watched;
  const mtime = typeof row._mtime === "number" ? row._mtime : Date.parse(String(row._mtime ?? ""));
  return Number.isFinite(mtime) ? mtime : 0;
}

/**
 * Newest playback evidence for a card, including its deduped members. This
 * mirrors cwPlaybackAt so the representative chosen here is also the row the
 * upstream sort placed at its activity position.
 */
function activity(row: CardRow): number {
  let best = stamp(row);
  const members = Array.isArray(row.cwMembers) ? (row.cwMembers as CardRow[]) : [];
  for (const member of members) {
    const at = stamp(member);
    if (at > best) best = at;
  }
  return best;
}

function seriesCardKey(hint: IdentityCardHint | undefined): string | null {
  if (!hint || hint.provisional || !hint.cardKey) return null;
  return hint.mediaType === "TV" || hint.mediaType === "ONA" ? hint.cardKey : null;
}

/**
 * Resolve displayed CW rows to a provider-show card key.
 *
 * The probe list is supplied by the caller because catalog rows (`tt…`) first
 * need the app's existing catalog-to-entry mapping. Rows without a reliable
 * series card (movies, OVAs, specials, unknown) keep their own card.
 */
export async function warmIdentityCards(
  rows: CardRow[],
  probesForRow: (rowId: string) => string[] = (rowId) => [rowId],
): Promise<boolean> {
  if (!identityEnabled()) return false;
  const probesByRow = new Map<string, string[]>();
  const probes = new Set<string>();
  for (const row of rows) {
    const rowProbes = [...new Set(probesForRow(row._id).filter(Boolean))];
    probesByRow.set(row._id, rowProbes);
    for (const probe of rowProbes) probes.add(probe);
  }
  if (probes.size === 0) return false;

  const hints = await fetchCardHints([...probes]);
  if (!hints) return false;
  const byId = new Map(hints.map((hint) => [hint.id, hint]));
  let changed = false;
  for (const row of rows) {
    let key: string | null = null;
    for (const probe of probesByRow.get(row._id) ?? []) {
      key = seriesCardKey(byId.get(probe));
      if (key) break;
    }
    const previous = cardCache.get(row._id);
    if (!previous || previous.key !== key) {
      cardCache.set(row._id, { at: Date.now(), key });
      changed = true;
    }
  }
  if (changed) notify();
  return changed;
}

/**
 * Merge rows that resolve to the same provider-show card. The representative is
 * the member with the most recent real activity; the other members ride along
 * in `cwMembers` so dismissal/cleanup can cover them.
 */
export function groupCwCards<T extends CardRow>(items: T[]): T[] {
  if (!identityFlags().cards) return items;
  const plain: Array<{ item: T; order: number }> = [];
  const groups = new Map<string, Array<{ row: T; order: number }>>();
  items.forEach((item, index) => {
    const key = identityCardKey(item._id);
    if (!key) {
      plain.push({ item, order: index });
      return;
    }
    const existing = groups.get(key);
    if (existing) existing.push({ row: item, order: index });
    else groups.set(key, [{ row: item, order: index }]);
  });
  let merged = false;
  const entries = [...plain];
  for (const members of groups.values()) {
    const only = members[0];
    if (!only) continue;
    if (members.length < 2) {
      entries.push({ item: only.row, order: only.order });
      continue;
    }
    merged = true;
    // The grouped card keeps the representative's position so a card does not
    // jump backwards just because an older member appeared first.
    const representative = members.reduce((best, member) =>
      activity(member.row) > activity(best.row) ? member : best,
    );
    entries.push({
      item: {
        ...representative.row,
        cwMembers: flattenCwSourceMembers(members.map((member) => member.row)),
      } as T,
      order: representative.order,
    });
  }
  if (!merged) return items;
  entries.sort((a, b) => a.order - b.order);
  return entries.map((entry) => entry.item);
}
