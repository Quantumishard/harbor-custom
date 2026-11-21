import { isCwDismissed } from "@/lib/cw-dismiss";
import { localCwEntryMerged, saveLocalCw } from "@/lib/local-cw";
import { ANIME_CLOUD_ID, episodeFromVideoId, type LibraryItem } from "@/lib/stremio";

const ABSORB_RECENT_MS = 45 * 864e5;

function mtimeMs(i: LibraryItem): number {
  const m = i._mtime as unknown;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  const parsed = Date.parse(String(m ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function progressRatio(positionMs: number, durationMs: number): number | null {
  if (!(durationMs > 0)) return null;
  return Math.max(0, Math.min(1, positionMs / durationMs));
}

function episodeRank(season?: number, episode?: number): number | null {
  return Number.isInteger(season) &&
    (season as number) >= 1 &&
    Number.isInteger(episode) &&
    (episode as number) >= 1
    ? (season as number) * 100_000 + (episode as number)
    : null;
}

function episodeOf(i: LibraryItem): { season?: number; episode?: number } {
  const season = i.state?.season;
  const episode = i.state?.episode;
  if (season && episode) return { season, episode };
  const vid = i.state?.video_id ?? "";
  const parts = vid.split(":");
  if (ANIME_CLOUD_ID.test(vid) && parts.length === 3) {
    const ep = Number(parts[2]);
    if (Number.isFinite(ep) && ep > 0) return { season: 1, episode: ep };
  }
  const parsed = episodeFromVideoId(vid);
  return parsed && parsed.episode > 0 ? parsed : {};
}

export function absorbCloudAnimeCw(items: LibraryItem[]): void {
  for (const i of items) {
    if (!ANIME_CLOUD_ID.test(i._id)) continue;
    if (i.removed && !i.temp) continue;
    const offset = i.state?.timeOffset ?? 0;
    if (offset <= 0 && !i.state?.video_id) continue;
    const t = mtimeMs(i);
    if (t <= 0 || Date.now() - t > ABSORB_RECENT_MS) continue;
    if (isCwDismissed(i)) continue;
    const existing = localCwEntryMerged(i._id, false);
    if (existing) {
      if (existing.t >= t) continue;
      // A newer `_mtime` is often library maintenance, not playback. Do not
      // replace a more advanced local checkpoint with a lower-progress cloud
      // one; only absorb progress that is genuinely further.
      const cloudEpisode = episodeOf(i);
      const existingRank = episodeRank(existing.season, existing.episode);
      const cloudRank = episodeRank(cloudEpisode.season, cloudEpisode.episode);
      const existingRatio = progressRatio(existing.positionMs, existing.durationMs);
      const cloudRatio = progressRatio(offset, i.state?.duration ?? 0);
      if (existingRank != null && cloudRank != null) {
        if (cloudRank < existingRank) continue;
        if (cloudRank === existingRank && existingRatio != null && cloudRatio != null) {
          if (cloudRatio <= existingRatio + 0.01) continue;
        }
      } else if (existingRatio != null && cloudRatio != null) {
        if (cloudRatio <= existingRatio + 0.01) continue;
      }
    }
    const ep = episodeOf(i);
    saveLocalCw({
      id: i._id,
      type: i.type === "movie" ? "movie" : "series",
      name: i.name,
      poster: i.poster,
      background: i.background,
      isAnime: true,
      source: "library",
      season: ep.season,
      episode: ep.episode,
      videoId: i.state?.video_id ?? undefined,
      positionMs: offset,
      durationMs: i.state?.duration ?? 0,
      t,
    });
  }
}
