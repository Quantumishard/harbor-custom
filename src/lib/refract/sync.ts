import type { WatchEvent } from "@/lib/watch-events";
import { parseRefractHistoryId } from "./identity";
import { activeProfileIsPrimary } from "@/lib/active-profile-id";
import {
  getRefractKey,
  lookupRefract,
  refractEnabled,
  RefractApiError,
  writeRefractEpisode,
  writeRefractMovie,
} from "./client";

export type RefractHint = {
  externalId?: string | null;
  episodes?: Array<{ season: number; episode: number }>;
  numbering?: "tmdb" | "tvdb" | "absolute";
};

type Job = {
  id: string;
  sourceId: string;
  type: "movie" | "episode";
  season?: number;
  episode?: number;
  numbering?: "tmdb" | "tvdb" | "absolute";
  watchedAt: number;
  requestId: string;
  attempts: number;
  nextAt: number;
};
type Failure = { sourceId: string; season?: number; episode?: number; reason: string };
type Store = {
  pending: Job[];
  recent: Record<string, number>;
  failed: Failure[];
  synced: number;
  message: string;
};

const STORE_KEY = "harbor.refract.sync.v1";
const EVENT = "harbor:refract-sync-changed";
const DEDUP_MS = 15 * 60 * 1000;
const MAX_PENDING = 2500;
const QUEUE_FULL = "Refract queue full; unable to save another watch";
let running = false;
let flushRequested = false;
let started = false;

const empty = (): Store => ({ pending: [], recent: {}, failed: [], synced: 0, message: "" });
function read(): Store {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || "null") as Partial<Store> | null;
    return data && Array.isArray(data.pending)
      ? {
          pending: data.pending,
          recent: data.recent || {},
          failed: Array.isArray(data.failed) ? data.failed : [],
          synced: Number(data.synced || 0),
          message: String(data.message || ""),
        }
      : empty();
  } catch {
    return empty();
  }
}
function save(state: Store): boolean {
  state.recent = Object.fromEntries(
    Object.entries(state.recent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2500),
  );
  state.failed = state.failed.slice(-80);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch {
    return false;
  }
}
export function subscribeRefractStatus(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
export function refractStatus() {
  const s = read();
  return {
    pending: s.pending.length,
    synced: s.synced,
    failed: s.failed.length,
    message: s.message,
    failureDetails: s.failed.slice(-4),
    failures: s.failed
      .slice(-4)
      .map(
        (f) => `${f.sourceId}${f.season != null ? ` S${f.season}E${f.episode}` : ""}: ${f.reason}`,
      ),
  };
}
export function resetRefractSync(): void {
  save(empty());
}
function keyOf(job: Job): string {
  return `${job.type}|${job.sourceId}|${job.season ?? ""}|${job.episode ?? ""}`;
}
function appendBatch(s: Store, jobs: Job[]): void {
  const pendingKeys = new Set(s.pending.map(keyOf));
  const now = Date.now();
  const fresh = jobs.filter((job) => {
    const key = keyOf(job);
    if (now - (s.recent[key] || 0) < DEDUP_MS || pendingKeys.has(key)) return false;
    pendingKeys.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  // Never accept only a prefix of a bulk history action.
  if (s.pending.length + fresh.length > MAX_PENDING) {
    const { sourceId, season, episode } = fresh[0];
    s.failed.push({
      sourceId,
      season: jobs.length === 1 ? season : undefined,
      episode: jobs.length === 1 ? episode : undefined,
      reason: QUEUE_FULL,
    });
    s.message = QUEUE_FULL;
    return;
  }
  s.pending.push(...fresh);
}
export function enqueueRefractWatch(event: WatchEvent, hint: RefractHint = {}): void {
  // A single personal key must never accidentally receive another Harbor profile's watches.
  if (!refractEnabled() || !activeProfileIsPrimary()) return;
  const sourceId = parseRefractHistoryId(
    hint.externalId || "",
    event.type === "movie" ? "movie" : "episode",
  )
    ? hint.externalId!
    : event.id;
  const at = event.at || Date.now();
  const s = read();
  const make = (type: Job["type"], season?: number, episode?: number): Job => ({
    id: crypto.randomUUID(),
    sourceId,
    type,
    season,
    episode,
    numbering: hint.numbering,
    watchedAt: at,
    requestId: crypto.randomUUID(),
    attempts: 0,
    nextAt: Date.now(),
  });
  const jobs: Job[] = [];
  if (event.type === "movie") jobs.push(make("movie"));
  else {
    const episodes = hint.episodes?.length
      ? hint.episodes
      : event.season !== undefined && event.episode !== undefined
        ? [{ season: event.season, episode: event.episode }]
        : [];
    for (const ep of episodes) {
      if (
        Number.isInteger(ep.season) &&
        ep.season >= 0 &&
        Number.isInteger(ep.episode) &&
        ep.episode >= 1
      )
        jobs.push(make("episode", ep.season, ep.episode));
    }
  }
  appendBatch(s, jobs);
  if (save(s)) void flushRefractSync();
}
class Unmatched extends Error {}
class Superseded extends Error {}
async function push(key: string, job: Job): Promise<void> {
  const parsed = parseRefractHistoryId(job.sourceId, job.type);
  if (!parsed) throw new Unmatched("No verified IMDb/TMDB/TVDB identity");
  const found = await lookupRefract(
    key,
    parsed.type,
    parsed.id,
    job.type,
    job.season,
    job.episode,
    job.numbering,
  );
  if (
    getRefractKey() !== key ||
    !refractEnabled() ||
    !activeProfileIsPrimary() ||
    !read().pending.some((pending) => pending.id === job.id)
  )
    throw new Superseded("Refract sync stopped before write");
  if (job.type === "movie") {
    const movie = found.find((x) => x.ids?.refract != null)?.ids?.refract;
    if (movie == null) throw new Unmatched("Movie not found in Refract");
    await writeRefractMovie(key, movie, job.watchedAt, job.requestId);
    return;
  }
  const episode = found.find(
    (x) => x.show?.ids?.refract != null && x.episode?.season != null && x.episode?.number != null,
  );
  if (
    episode?.show?.ids?.refract == null ||
    episode.episode?.season == null ||
    episode.episode?.number == null
  )
    throw new Unmatched("Episode not found; verify season numbering");
  await writeRefractEpisode(
    key,
    episode.show.ids.refract,
    episode.episode.season,
    episode.episode.number,
    job.watchedAt,
  );
}
export async function flushRefractSync(): Promise<void> {
  if (running) {
    flushRequested = true;
    return;
  }
  if (!refractEnabled() || !activeProfileIsPrimary()) return;
  const key = getRefractKey();
  if (!key) return;
  running = true;
  try {
    for (let count = 0; count < 16; count++) {
      if (getRefractKey() !== key || !refractEnabled() || !activeProfileIsPrimary()) break;
      const s = read();
      const job = s.pending.find((x) => x.nextAt <= Date.now());
      if (!job) break;
      try {
        await push(key, job);
        if (getRefractKey() !== key) break;
        const current = read();
        // A disconnect/reconnect with the same key can reset the queue during the write.
        if (!current.pending.some((x) => x.id === job.id)) continue;
        current.pending = current.pending.filter((x) => x.id !== job.id);
        current.recent[keyOf(job)] = Date.now();
        current.synced++;
        // Keep a rejected bulk action visible when an unrelated pending watch succeeds.
        current.message = current.failed.some((failure) => failure.reason === QUEUE_FULL)
          ? QUEUE_FULL
          : "Last watched item sent successfully";
        save(current);
      } catch (error) {
        if (error instanceof Superseded || getRefractKey() !== key) break;
        const current = read();
        const pending = current.pending.find((x) => x.id === job.id);
        if (!pending) continue;
        if (
          error instanceof Unmatched ||
          (error instanceof RefractApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![401, 403, 409, 429].includes(error.status))
        ) {
          current.pending = current.pending.filter((x) => x.id !== job.id);
          current.failed.push({
            sourceId: job.sourceId,
            season: job.season,
            episode: job.episode,
            reason: error instanceof Error ? error.message : "Unknown error",
          });
          current.message = "Some items could not be matched or sent";
        } else {
          pending.attempts++;
          const status = error instanceof RefractApiError ? error.status : 0;
          pending.nextAt =
            Date.now() +
            (status === 401 || status === 403
              ? 60 * 60_000
              : Math.max(
                  error instanceof RefractApiError ? error.retryAfterMs : 0,
                  Math.min(60 * 60_000, 5000 * 2 ** Math.min(pending.attempts, 8)),
                ));
          current.message =
            status === 401 || status === 403
              ? "Refract denied access; check key and permissions"
              : "Network error; retry scheduled";
        }
        save(current);
      }
    }
  } finally {
    running = false;
    if (flushRequested) {
      flushRequested = false;
      void flushRefractSync();
    }
  }
}
export function retryRefractSync(): void {
  const s = read();
  for (const job of s.pending) job.nextAt = Date.now();
  save(s);
  void flushRefractSync();
}
export function startRefractSync(): void {
  if (started) {
    void flushRefractSync();
    return;
  }
  started = true;
  const poll = () => void flushRefractSync();
  window.addEventListener("online", poll);
  window.setInterval(poll, 60_000);
  poll();
}
