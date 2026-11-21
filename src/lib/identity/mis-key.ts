import { fetchCardHints, fetchWindowOwners } from "./hints";
import { identityEnabled } from "./flags";

type MisKeyRow = {
  _id: string;
  state?: { season?: number };
};

type Retirement = { at: number; ownerEntry: number };

const TTL_MS = 5 * 60_000;
const retired = new Map<string, Retirement>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function identityMisKeyVersion(): number {
  return version;
}

export function subscribeIdentityMisKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when a window proved this row's checkpoint belongs to another work. */
export function isIdentityMisKeyRetired(rowId: string): boolean {
  const hit = retired.get(rowId);
  if (!hit) return false;
  if (Date.now() - hit.at > TTL_MS) {
    retired.delete(rowId);
    return false;
  }
  return true;
}

export function clearIdentityMisKeyCache(): void {
  retired.clear();
  notify();
}

/**
 * Prove and mark stale rows.
 *
 * A row is mis-keyed when its entry maps to a provider show/season, but the
 * checkpoint claims a season that entry does not own, while another series-like
 * entry of the same provider show owns exactly that season. This is the
 * `mal:14719` S6E9 case: the 2012 entry owns season 1, SBR owns season 6.
 */
export async function warmIdentityMisKey(
  rows: MisKeyRow[],
  probesForRow: (rowId: string) => string[] = (rowId) => [rowId],
): Promise<boolean> {
  if (!identityEnabled() || rows.length === 0) return false;
  const probes = new Map<string, string[]>();
  const all = new Set<string>();
  for (const row of rows) {
    const rowProbes = [...new Set(probesForRow(row._id).filter(Boolean))];
    probes.set(row._id, rowProbes);
    for (const probe of rowProbes) all.add(probe);
  }
  if (all.size === 0) return false;
  const hints = await fetchCardHints([...all]);
  if (!hints) return false;
  const byId = new Map(hints.map((hint) => [hint.id, hint]));

  const next = new Map<string, Retirement>();
  for (const row of rows) {
    const season = row.state?.season;
    if (!Number.isInteger(season) || (season as number) < 1) continue;
    const hint = (probes.get(row._id) ?? [])
      .map((probe) => byId.get(probe))
      .find((candidate) => candidate && !candidate.provisional && candidate.entry != null);
    if (!hint?.entry || !hint.windows?.length) continue;

    // Distinct provider shows this entry belongs to.
    const shows = new Map<string, { tvdb: number | null; tmdb: number | null }>();
    for (const window of hint.windows) {
      if (window.tvdb == null && window.tmdbtv == null) continue;
      const key = `${window.tvdb ?? ""}|${window.tmdbtv ?? ""}`;
      shows.set(key, { tvdb: window.tvdb, tmdb: window.tmdbtv });
    }
    if (shows.size === 0) continue;

    for (const show of shows.values()) {
      // The row's own entry may legitimately own this season; then it is not stale.
      const ownsSeason = hint.windows.some(
        (window) =>
          window.tvdb === show.tvdb &&
          window.tmdbtv === show.tmdb &&
          (window.tvdbSeason === season || window.tmdbSeason === season),
      );
      if (ownsSeason) break;
      const owners = await fetchWindowOwners(show, season as number);
      const candidates = owners.filter(
        (candidate) =>
          candidate.entry !== hint.entry &&
          (candidate.mediaType === "TV" || candidate.mediaType === "ONA"),
      );
      // Ambiguous ownership is not proof. Only a single other owner retires.
      const distinct = new Map(candidates.map((candidate) => [candidate.entry, candidate]));
      if (distinct.size > 1) continue;
      const owner = candidates[0];
      if (owner) {
        next.set(row._id, { at: Date.now(), ownerEntry: owner.entry });
        break;
      }
    }
  }

  const changed =
    next.size !== retired.size ||
    [...next].some(([id, value]) => {
      const previous = retired.get(id);
      return !previous || previous.ownerEntry !== value.ownerEntry;
    });
  if (!changed) return false;
  retired.clear();
  for (const [id, value] of next) retired.set(id, value);
  notify();
  return true;
}
