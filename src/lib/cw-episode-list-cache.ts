import type { Meta } from "@/lib/cinemeta";
import type { PlayEpisode } from "@/lib/view";
import { loadInstalled, loadDisabledAddons } from "@/lib/addon-store";
import { loadDisplayOrder } from "@/lib/addons-store/reorder";
import { effectiveTmdbLanguage } from "@/lib/providers/tmdb/tmdb-client";
import { EpisodeListUnavailableError, fetchEpisodeList } from "@/lib/series-episodes";
import {
  episodeCacheTtl,
  loadMedia,
  mediaCacheGeneration,
  MEDIA_TTL,
} from "@/lib/media-cache";

/** Only complete, nonempty lists can answer CW advancement decisions. */
function validEpisodeList(value: PlayEpisode[]): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8000 &&
    value.every(
      (episode) =>
        episode != null &&
        Number.isInteger(episode.season) &&
        episode.season >= 0 &&
        Number.isInteger(episode.episode) &&
        episode.episode >= 0,
    )
  );
}

function metadataSettingsRevision(): { revision: string | null; addonOnly: boolean } {
  try {
    const settings = JSON.parse(localStorage.getItem("harbor.settings") ?? "{}") as {
      addonOnlyMetadata?: boolean;
      metadataSources?: { episodes?: unknown };
      metadataAddonOrder?: unknown;
      tvdbKey?: string;
      tvdbSeasonType?: string;
      tmdbKey?: string;
    };
    // Settings unrelated to metadata (including startup-rewritten preferences)
    // must not invalidate every episode list on each launch. Include the
    // actual provider configuration and the installed/disabled addon chain.
    // The disk key hashes this revision; URLs/keys are never written in clear.
    const addons = loadInstalled().map((addon) => [
      addon.id, addon.transportUrl, addon.manifest?.id, addon.manifest?.version,
      addon.manifest?.resources, addon.manifest?.types, addon.manifest?.idPrefixes,
    ]);
    const revision = JSON.stringify([
      settings.addonOnlyMetadata === true,
      settings.metadataSources?.episodes ?? null,
      settings.metadataAddonOrder ?? null,
      settings.tvdbKey ?? null,
      settings.tvdbSeasonType ?? null,
      settings.tmdbKey ?? null,
      effectiveTmdbLanguage(),
      addons,
      [...loadDisabledAddons()].sort(),
      loadDisplayOrder(),
    ]);
    return { revision, addonOnly: settings.addonOnlyMetadata === true };
  } catch {
    // Unknown configuration is not a safe basis for a persistent lookup.
    return { revision: null, addonOnly: true };
  }
}

/** An in-memory list is valid only while its metadata settings and cache epoch match. */
export function cwEpisodeListCacheToken(): string {
  const settings = metadataSettingsRevision();
  return JSON.stringify([mediaCacheGeneration(), settings.revision, settings.addonOnly]);
}

export function cwEpisodeListCacheTtl(episodes: PlayEpisode[]): number {
  return Math.min(episodeCacheTtl(episodes), MEDIA_TTL.episodes);
}

/**
 * Persistent, owner-scoped CW episode metadata. A cached list must have been
 * returned by a successful requireComplete fetch; an empty list or failed
 * lookup never proves that a show is finished. Expired data is not used for
 * removal or next-episode decisions.
 *
 * Addon-only configurations bypass the assembled-list cache for now: addon
 * installation/enablement lives outside the settings mirror and can change
 * without producing a new cache key.
 */
export async function fetchCachedCwEpisodeList(
  meta: Meta,
  opts: { tmdbKey: string; signal: AbortSignal },
  ownerScope: string,
): Promise<PlayEpisode[]> {
  if (opts.signal.aborted) throw new DOMException("CW fetch aborted", "AbortError");
  const settings = metadataSettingsRevision();
  if (!ownerScope || settings.revision == null || settings.addonOnly) {
    return fetchEpisodeList(meta, { ...opts, requireComplete: true });
  }

  const generation = mediaCacheGeneration();
  const result = await loadMedia<PlayEpisode[]>(
    "cw-episode-list",
    [3, ownerScope, meta.id, meta.type, opts.tmdbKey, settings.revision],
    async () => {
      const episodes = await fetchEpisodeList(meta, { ...opts, requireComplete: true });
      return validEpisodeList(episodes) ? episodes : null;
    },
    {
      // Air dates shorten this window for imminent episodes; old lists can
      // survive launches for up to twelve hours.
      ttl: (episodes) => Math.min(episodeCacheTtl(episodes), MEDIA_TTL.episodes),
      stale: MEDIA_TTL.stale,
      valid: validEpisodeList,
      // A stale/failed list can never justify removing a CW card.
      staleWhileRevalidate: false,
      fallbackOnError: false,
    },
  );
  if (opts.signal.aborted || generation !== mediaCacheGeneration())
    throw new DOMException("CW fetch aborted", "AbortError");
  if (!result.value) throw new EpisodeListUnavailableError();
  return result.value;
}
