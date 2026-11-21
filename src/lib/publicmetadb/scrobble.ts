import { activeProfileId } from "@/lib/active-profile-id";
import { randomUuid } from "@/lib/uuid";
import { PmdbApiError, pmdbRequest } from "./client";
import { markPmdbWatched } from "./history";
import { getTmdbForExternal } from "./mappings";
import { retainPendingCompletion, type PendingResume } from "./pending-sync";
import { getSession, isAuthenticated } from "./session";
import type { PmdbResumeResponse, PmdbSaveResumeResponse, PmdbTarget } from "./types";

const RESUME_LOOKUP_PER_PAGE = 100;
// The conflicting point was written moments ago, so it sits on the first
// pages. Bound the scan: every page is a request against the hourly budget.
const RESUME_LOOKUP_MAX_PAGES = 3;
const RESUME_DELETE_MAX_PAGES = 25;

function resumeSeasonEpisode(target: PmdbTarget): { season: number; episode: number } {
  if (target.media_type === "movie") return { season: 0, episode: 0 };
  return { season: target.season ?? 0, episode: target.episode ?? 0 };
}

function resumeBody(target: PmdbTarget, positionMs: number, runtimeMs: number) {
  const { season, episode } = resumeSeasonEpisode(target);
  return {
    tmdb_id: target.tmdb_id,
    media_type: target.media_type,
    season,
    episode,
    position_ms: Math.round(positionMs),
    runtime_ms: Math.round(runtimeMs),
    id_type: target.id_type,
    id_value: target.id_value,
  };
}

function isSameResumePoint(
  tmdbId: number | undefined,
  mediaType: string,
  season: number,
  episode: number,
  isMovie: boolean,
): (i: {
  tmdb_id: number;
  media_type: string;
  season?: number | null;
  episode?: number | null;
}) => boolean {
  return (i) => {
    if (tmdbId == null || i.tmdb_id !== tmdbId || i.media_type !== mediaType) return false;
    const iSeason = Number(i.season ?? 0);
    const iEpisode = Number(i.episode ?? 0);
    return isMovie ? iSeason === 0 && iEpisode === 0 : iSeason === season && iEpisode === episode;
  };
}

async function findResumeId(target: PmdbTarget): Promise<string | null> {
  let tmdbId = target.tmdb_id;
  if (tmdbId == null) {
    if (!target.id_type || !target.id_value) return null;
    const found = await getTmdbForExternal(target.id_type, target.id_value).catch(() => null);
    if (!found || (found.media_type && found.media_type !== target.media_type)) return null;
    tmdbId = found.tmdb_id;
  }
  const { season, episode } = resumeSeasonEpisode(target);
  const isMovie = target.media_type === "movie";
  const match = isSameResumePoint(tmdbId, target.media_type, season, episode, isMovie);
  for (let page = 1; page <= RESUME_LOOKUP_MAX_PAGES; page++) {
    try {
      const list = await pmdbRequest<PmdbResumeResponse>(
        `/api/external/resume?page=${page}&perPage=${RESUME_LOOKUP_PER_PAGE}`,
        { method: "GET" },
      );
      const found = list?.items?.find(match);
      if (found?.id) return found.id;
      const totalPages = Math.max(1, Number(list?.totalPages ?? 1) || 1);
      if (page >= totalPages || !Array.isArray(list?.items) || list.items.length === 0) return null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function pmdbDeleteResumeForTarget(
  target: PmdbTarget,
  stillOwned?: () => boolean,
): Promise<boolean> {
  const id = await findResumeId(target);
  if (!id || stillOwned?.() === false) return false;
  return pmdbDeleteResume(id);
}

export async function pmdbDeleteResumesForTitle(
  target: PmdbTarget,
  options: { assertCurrent?: () => void } = {},
): Promise<number> {
  if (!isAuthenticated()) return 0;
  options.assertCurrent?.();
  let tmdbId = target.tmdb_id;
  if (tmdbId == null) {
    if (!target.id_type || !target.id_value) return 0;
    const found = await getTmdbForExternal(target.id_type, target.id_value).catch(() => null);
    options.assertCurrent?.();
    if (!found || (found.media_type && found.media_type !== target.media_type)) return 0;
    tmdbId = found.tmdb_id;
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return 0;

  const ids: string[] = [];
  for (let page = 1; page <= RESUME_DELETE_MAX_PAGES; page++) {
    options.assertCurrent?.();
    const list = await pmdbRequest<PmdbResumeResponse>(
      `/api/external/resume?page=${page}&perPage=${RESUME_LOOKUP_PER_PAGE}`,
      { method: "GET" },
    );
    options.assertCurrent?.();
    if (!Array.isArray(list?.items))
      throw new Error("PublicMetaDB resume state could not be read safely.");
    for (const item of list.items) {
      if (item.tmdb_id === tmdbId && item.media_type === target.media_type && item.id)
        ids.push(item.id);
    }
    const totalPages = Math.max(1, Number(list?.totalPages ?? 1) || 1);
    if (totalPages > RESUME_DELETE_MAX_PAGES)
      throw new Error("PublicMetaDB has too many resume pages to clear safely.");
    if (page >= totalPages || list.items.length === 0) break;
  }

  for (const id of ids) {
    options.assertCurrent?.();
    const ok = await pmdbDeleteResume(id);
    options.assertCurrent?.();
    if (!ok) throw new Error("PublicMetaDB did not confirm resume removal.");
  }
  return ids.length;
}

export async function pmdbSaveResume(
  target: PmdbTarget,
  positionMs: number,
  runtimeMs: number,
  isRetry = false,
): Promise<PmdbSaveResumeResponse | null> {
  if (!isAuthenticated()) return null;

  try {
    return await pmdbRequest<PmdbSaveResumeResponse>("/api/external/resume", {
      method: "POST",
      body: resumeBody(target, positionMs, runtimeMs),
    });
  } catch (err) {
    if (!isRetry && err instanceof PmdbApiError && err.status === 409) {
      try {
        const id = await findResumeId(target);
        if (id) {
          await pmdbDeleteResume(id);
          return await pmdbSaveResume(target, positionMs, runtimeMs, true);
        }
      } catch (recoveryErr) {
        console.error("PublicMetaDB 409 recovery failed:", recoveryErr);
      }
    }
    console.error("PublicMetaDB resume save failed:", err);
    return null;
  }
}

type Playback = {
  id: string;
  watchedAt?: string;
  watched: boolean;
  marking?: Promise<boolean>;
};

// Replayed snapshots share the completion state of their live player, when present.
const activePlaybacks = new Map<string, Playback>();

export function startPmdbPlayback(): Playback {
  const playback: Playback = { id: randomUuid(), watched: false };
  activePlaybacks.set(playback.id, playback);
  return playback;
}

export function endPmdbPlayback(playback: Playback): void {
  activePlaybacks.delete(playback.id);
}

export async function syncPmdbPlayback(snapshot: PendingResume): Promise<boolean> {
  const { target, positionMs, runtimeMs, playbackId } = snapshot;
  const playback = playbackId ? activePlaybacks.get(playbackId) : undefined;
  const owner = activeProfileId();
  const session = getSession();
  const stillOwned = () => activeProfileId() === owner && getSession()?.apiKey === session?.apiKey;
  if (!session) return false;
  if (playback?.watched) return true;

  if (!snapshot.watchedAt && !playback?.watchedAt) {
    const response = await pmdbSaveResume(target, positionMs, runtimeMs);
    if (response?.action !== "completed") return response != null;
    if (!stillOwned()) return false;
  }

  if (playback?.watched) return true;
  const watchedAt =
    playback?.watchedAt ?? snapshot.watchedAt ?? new Date(snapshot.at).toISOString();
  retainPendingCompletion(snapshot, watchedAt);
  if (playback?.marking) return playback.marking;

  const mark = markPmdbWatched(target, watchedAt, {
    assertCurrent: () => {
      if (!stillOwned())
        throw new DOMException("PublicMetaDB playback owner changed", "AbortError");
    },
  }).then(async (ok) => {
    if (!ok || !stillOwned()) return false;
    if (playback) playback.watched = true;
    await pmdbDeleteResumeForTarget(target, stillOwned);
    return true;
  });

  if (playback) {
    playback.watchedAt = watchedAt;
    playback.marking = mark;
  }
  try {
    return await mark;
  } finally {
    if (playback) playback.marking = undefined;
  }
}

export async function pmdbDeleteResumeOutcome(
  resumeId: string,
): Promise<{ ok: boolean; retryAfterMs?: number; rateLimited?: boolean }> {
  if (!isAuthenticated() || !resumeId) return { ok: false };

  try {
    await pmdbRequest(`/api/external/resume/${encodeURIComponent(resumeId)}`, {
      method: "DELETE",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof PmdbApiError) {
      if (err.status === 404) return { ok: true };
      const retryAfterMs = err.retryAt != null ? Math.max(0, err.retryAt - Date.now()) : undefined;
      return {
        ok: false,
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
        ...(err.status === 429 ? { rateLimited: true } : {}),
      };
    }
    return { ok: false };
  }
}

export async function pmdbDeleteResume(resumeId: string): Promise<boolean> {
  return (await pmdbDeleteResumeOutcome(resumeId)).ok;
}
