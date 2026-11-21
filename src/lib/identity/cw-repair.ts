import { invokeIdentity } from "./client";
import { fetchCardHints, fetchWindowOwners } from "./hints";
import { identityEnabled } from "./flags";
import type { IdentityBundle, IdentityCardHint } from "./types";

/**
 * Display-only correction of a checkpoint attached to the wrong anime entry.
 * The original item, including its playback state and source id, is never
 * written back or mutated; it remains in cwMembers for dismissal and history.
 *
 * A TVDB season alone is NOT proof: split-cour series can have several owners.
 * Require either the saved native Kitsu stream or an independently verified
 * catalog checkpoint, the matching exact season window, one provider owner,
 * and a valid episode in the native entry.
 */
export type RepairableCwRow = {
  _id: string;
  type?: string;
  isAnime?: boolean;
  external?: string;
  local?: boolean;
  manualWatched?: boolean;
  upNext?: boolean;
  caughtUp?: boolean;
  waitingForAir?: boolean;
  state?: {
    season?: number;
    episode?: number;
    video_id?: string;
    lastWatched?: string;
  };
  _mtime?: string;
  name?: string;
  altIds?: string[];
  /** The original source id when a verified UI row is displayed as its native entry. */
  cwRepairSourceId?: string;
  cwRepairNativeStreamId?: string;
  cwMembers?: RepairableCwRow[];
};

type Candidate = {
  key: string;
  source: string;
  target: string;
  season: number;
  episode: number;
  nativeEpisode: number;
  catalog: boolean;
};

export type CatalogCwEvidence = { target: string; nativeEpisode: number };
export type CatalogCwEvidenceResolver = (
  row: RepairableCwRow,
) => Promise<CatalogCwEvidence | null>;

const STREAM = /^kitsu:([1-9]\d*):([1-9]\d*)$/;
const NATIVE = /^(?:kitsu|mal|anilist|anidb):[1-9]\d*$/;
const CATALOG = /^(?:tt[1-9]\d*|tmdb:tv:[1-9]\d*)$/;
const TTL_MS = 5 * 60_000;
const verified = new Map<string, { target: string; nativeEpisode: number; at: number }>();
const listeners = new Set<() => void>();
let version = 0;
let generation = 0;

export function subscribeVerifiedCwRepairs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function verifiedCwRepairVersion(): number {
  return version;
}

export function clearVerifiedCwRepairs(): void {
  generation += 1; // Also invalidate an in-flight verification on a pack refresh.
  if (verified.size === 0) return;
  verified.clear();
  version += 1;
  listeners.forEach((listener) => listener());
}

function safeCheckpoint(row: RepairableCwRow): { key: string; season: number; episode: number } | null {
  if (row.type !== "series" || (!NATIVE.test(row._id) && !CATALOG.test(row._id)))
    return null;
  // Tracker imports, next-up and local history have independent source semantics.
  if (row.external || row.local || row.manualWatched || row.upNext ||
      row.caughtUp || row.waitingForAir) return null;
  const season = row.state?.season;
  const episode = row.state?.episode;
  if (!Number.isInteger(season) || (season as number) < 1 ||
      !Number.isInteger(episode) || (episode as number) < 1) return null;
  const videoId = row.state?.video_id ?? "";
  if (!videoId) return null;
  return {
    key: [row._id, season, episode, videoId].join("|"),
    season: season!,
    episode: episode!,
  };
}

function candidate(row: RepairableCwRow): Candidate | null {
  const checkpoint = safeCheckpoint(row);
  if (!checkpoint || !NATIVE.test(row._id)) return null;
  const parsed = STREAM.exec(row.state?.video_id ?? "");
  if (!parsed) return null;
  const target = `kitsu:${parsed[1]}`;
  if (row._id === target) return null;
  return {
    ...checkpoint,
    source: row._id,
    target,
    nativeEpisode: Number(parsed[2]),
    catalog: false,
  };
}

async function candidateForCatalog(
  row: RepairableCwRow,
  resolve: CatalogCwEvidenceResolver,
): Promise<Candidate | null> {
  const checkpoint = safeCheckpoint(row);
  if (!checkpoint || !CATALOG.test(row._id)) return null;
  const saved = row.state?.video_id ?? "";
  // A catalog checkpoint may use a native stream or its own provider episode
  // id, but never a differently named catalog/season/episode or an opaque id.
  const parsed = STREAM.exec(saved);
  if (!parsed) {
    const own = `${row._id}:${checkpoint.season}:${checkpoint.episode}`;
    const imdb = row.altIds?.find((id) => /^tt[1-9]\d*$/.test(id));
    const alt = imdb ? `${imdb}:${checkpoint.season}:${checkpoint.episode}` : null;
    if (saved !== own && saved !== alt) return null;
  }
  const proof = await resolve(row).catch(() => null);
  if (!proof || !/^kitsu:[1-9]\d*$/.test(proof.target) ||
      !Number.isInteger(proof.nativeEpisode) || proof.nativeEpisode < 1) return null;
  if (parsed && proof.target !== `kitsu:${parsed[1]}`) return null;
  if (parsed && proof.nativeEpisode !== Number(parsed[2])) return null;
  return {
    ...checkpoint, source: row._id, target: proof.target,
    nativeEpisode: proof.nativeEpisode, catalog: true,
  };
}

function sharedShow(a: IdentityCardHint, b: IdentityCardHint) {
  const shows = new Map<string, { tvdb: number | null; tmdb: number | null }>();
  for (const left of a.windows ?? []) {
    for (const right of b.windows ?? []) {
      // A TVDB match cannot override a contradictory known TMDB show id,
      // or vice versa. An incomplete mapping is acceptable; a conflict isn't.
      if (left.tvdb != null && right.tvdb != null && left.tvdb !== right.tvdb) continue;
      if (left.tmdbtv != null && right.tmdbtv != null && left.tmdbtv !== right.tmdbtv) continue;
      const tvdb = left.tvdb != null && left.tvdb === right.tvdb ? left.tvdb : null;
      const tmdb = left.tmdbtv != null && left.tmdbtv === right.tmdbtv ? left.tmdbtv : null;
      if (tvdb == null && tmdb == null) continue;
      const key = `${tvdb ?? ""}|${tmdb ?? ""}`;
      shows.set(key, { tvdb, tmdb });
    }
  }
  return [...shows.values()];
}

function ownsSeason(hint: IdentityCardHint, show: { tvdb: number | null; tmdb: number | null }, season: number) {
  return (hint.windows ?? []).some((window) =>
    ((show.tvdb != null && window.tvdb === show.tvdb) ||
      (show.tmdb != null && window.tmdbtv === show.tmdb)) &&
    (window.tvdbSeason === season || window.tmdbSeason === season));
}

/**
 * Verify corrections asynchronously against the real identity service.
 * If the service fails, ownership is missing, or a season is ambiguous, no
 * proof is recorded and the caller continues displaying the original row.
 */
export async function warmVerifiedCwRepairs(
  rows: readonly RepairableCwRow[],
  catalogResolver?: CatalogCwEvidenceResolver,
): Promise<boolean> {
  if (!identityEnabled()) return false;
  const startGeneration = generation;
  const now = Date.now();
  const pendingRows = rows.filter((row) => {
    const checkpoint = safeCheckpoint(row);
    if (!checkpoint) return false;
    const existing = verified.get(checkpoint.key);
    return !existing || now - existing.at >= TTL_MS;
  });
  if (pendingRows.length === 0) return false;
  const resolver = catalogResolver ?? (async (row: RepairableCwRow) => {
    const { catalogCwEvidence } = await import("./catalog-cw-evidence");
    return catalogCwEvidence(row);
  });
  const candidates = (await Promise.all(pendingRows.map(async (row) =>
    candidate(row) ?? candidateForCatalog(row, resolver),
  ))).filter((value): value is Candidate => value != null);
  if (candidates.length === 0) return false;
  const hints = await fetchCardHints([...new Set(candidates.flatMap((c) =>
    c.catalog ? [c.target] : [c.source, c.target],
  ))]);
  if (!hints) return false;
  const byId = new Map(hints.map((hint) => [hint.id, hint]));
  const proofs: Array<{ key: string; target: string; nativeEpisode: number }> = [];
  for (const c of candidates) {
    const source = c.catalog ? null : byId.get(c.source);
    const target = byId.get(c.target);
    if (!target?.entry || target.provisional ||
        !["TV", "ONA"].includes(target.mediaType ?? "")) continue;
    if (!c.catalog && (!source?.entry || source.provisional ||
        source.entry === target.entry ||
        !["TV", "ONA"].includes(source.mediaType ?? ""))) continue;
    const shows = c.catalog
      ? (target.windows ?? [])
          .filter((window) => window.tvdb != null || window.tmdbtv != null)
          .map((window) => ({ tvdb: window.tvdb, tmdb: window.tmdbtv }))
      : sharedShow(source!, target);
    const distinctShows = new Map(shows.map((show) => [
      `${show.tvdb ?? ""}|${show.tmdb ?? ""}`, show,
    ]));
    if (distinctShows.size !== 1) continue;
    const show = [...distinctShows.values()][0]!;
    // TMDB's numeric show ID must agree exactly with the offline mapping.
    if (c.source.startsWith("tmdb:tv:") && show.tmdb !== Number(c.source.slice(8))) continue;
    // A catalog proof already matched the exact IMDb/episode in a native
    // provider video; a native source must additionally NOT own this season.
    if ((!c.catalog && ownsSeason(source!, show, c.season)) ||
        !ownsSeason(target, show, c.season)) continue;
    const owners = await fetchWindowOwners(show, c.season);
    const eligible = new Set(
      owners.filter((o) => o.mediaType === "TV" || o.mediaType === "ONA").map((o) => o.entry),
    );
    if (eligible.size !== 1 || !eligible.has(target.entry)) continue;
    const bundle = await invokeIdentity<IdentityBundle>("identity_entry_bundle", { key: c.target });
    if (!bundle || bundle.entry !== target.entry ||
        !Number.isInteger(bundle.episodes) || (bundle.episodes ?? 0) < c.nativeEpisode)
      continue;
    proofs.push({ key: c.key, target: c.target, nativeEpisode: c.nativeEpisode });
  }
  if (!proofs.length || startGeneration !== generation) return false;
  for (const { key, target, nativeEpisode } of proofs)
    verified.set(key, { target, nativeEpisode, at: Date.now() });
  // Memory-only proof. A new session or pack refresh has to verify again.
  version += 1;
  listeners.forEach((listener) => listener());
  return true;
}

function activity(row: RepairableCwRow): number {
  const timestamps = [row, ...(row.cwMembers ?? [])].flatMap((part) => [
    Date.parse(part.state?.lastWatched ?? ""),
    Date.parse(part._mtime ?? ""),
  ]);
  return Math.max(0, ...timestamps.filter(Number.isFinite));
}

function members<T extends RepairableCwRow>(row: T): T[] {
  return row.cwMembers?.length ? (row.cwMembers as T[]) : [row];
}

/**
 * Re-key only the displayed copy. When the native entry already has a CW row,
 * keep whichever checkpoint is newer and retain BOTH originals as members.
 * The source library, playback position, dismissal state and sync data are not
 * changed here.
 */
export function applyVerifiedCwRepairs<T extends RepairableCwRow>(rows: T[]): T[] {
  if (!rows.length) return rows;
  const now = Date.now();
  // A native row may be an up-next card or a separate tracker import. Never
  // merge that independently managed item into a repaired library checkpoint.
  const protectedIds = new Set(rows.filter((row) =>
    row.external || row.local || row.manualWatched || row.upNext ||
    row.caughtUp || row.waitingForAir,
  ).map((row) => row._id));
  const repairedTargets = new Set<string>();
  const mapped = rows.map((row) => {
    const checkpoint = safeCheckpoint(row);
    const hit = checkpoint ? verified.get(checkpoint.key) : null;
    const native = candidate(row);
    if (!hit || now - hit.at > TTL_MS ||
        (NATIVE.test(row._id) && native?.target !== hit.target) ||
        protectedIds.has(hit.target)) return row;
    repairedTargets.add(hit.target);
    return {
      ...row,
      _id: hit.target,
      cwRepairSourceId: row._id,
      cwRepairNativeStreamId: `${hit.target}:${hit.nativeEpisode}`,
      cwMembers: members(row),
    } as T;
  });
  if (repairedTargets.size === 0) return rows;

  // Only collapse rows directly involved in a repair. Unrelated duplicate
  // checkpoints must remain independent for the existing CW pipeline.
  const indexes = new Map<string, number>();
  const output: Array<{ row: T; order: number }> = [];
  mapped.forEach((row, order) => {
    if (!repairedTargets.has(row._id)) {
      output.push({ row, order });
      return;
    }
    const index = indexes.get(row._id);
    if (index == null) {
      indexes.set(row._id, output.length);
      output.push({ row, order });
      return;
    }
    const existing = output[index]!;
    const newerIsRow = activity(row) > activity(existing.row);
    const newer = newerIsRow ? row : existing.row;
    const all = [...members(existing.row), ...members(row)];
    const distinct = [...new Set(all)];
    // Place the merged card at its newest checkpoint, not the first alias.
    output[index] = {
      row: { ...newer, cwMembers: distinct } as T,
      order: newerIsRow ? order : existing.order,
    };
  });
  return output.sort((a, b) => a.order - b.order).map((entry) => entry.row);
}
