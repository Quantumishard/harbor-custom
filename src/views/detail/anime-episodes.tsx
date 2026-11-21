import { lastPlayedEpisode } from "@/lib/resume";
import { getAnimeCwId } from "@/lib/anime-cw-ids";
import {
  nativeSeasonRows, nativeSeasonOwnerId, verifiedSeasonOwnerFromEpisodes,
} from "./anime-episodes/anime-season-key";
import { matchingKitsuSeasonEntry } from "./anime-episodes/anime-season-lookup";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Meta } from "@/lib/cinemeta";
import { scrollToDataEp } from "@/lib/episode-scroll";
import { type FranchiseEntry } from "@/lib/providers/anime-detail";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import { isUpcomingDate } from "@/lib/dates";
import { airedOnly } from "@/lib/aired";
import { useSettings } from "@/lib/settings";
import { effectiveOrderProvider, tvdbPanelEnabled } from "@/lib/settings/episode-order";
import { useView } from "@/lib/view";
import { fetchWatchedKeySet } from "@/lib/trakt/history";
import { useTrakt } from "@/lib/trakt/provider";
import { useAnilistWatched } from "@/lib/anilist/use-anilist-watched";
import { useMalWatched } from "@/lib/mal/use-mal-watched";
import { usePublicMetaDb } from "@/lib/publicmetadb/provider";
import { fetchPmdbWatchedKeySet } from "@/lib/publicmetadb/history";
import { resolvePmdbTarget } from "@/lib/publicmetadb/ids";
import { EpisodeWatchedMenu, type WatchedMenuTarget } from "@/components/episode-watched-menu";
import { manualWatchedVersion, subscribeManualWatched } from "@/lib/manual-watched";
import { useT } from "@/lib/i18n";
import { AnimeEpisodeRow } from "./anime-episodes/episode-row";
import { AnimeSeasonPicker } from "./anime-episodes/anime-season-picker";
import { mapSeasonToEntry, type SeasonArtSelection } from "./anime-episodes/anime-season-art";
import { MovieEntryCard } from "./anime-episodes/movie-entry-card";
import { useAnimeOrder } from "./anime-episodes/use-anime-order";
import { SeasonArcPicker } from "./series-episodes/season-arc-picker";
import { AnimeEpisodeStrip } from "./anime-episode-strip";
import { EpisodeGridControls } from "./episode-grid-controls";
import { EpisodeLayoutToggle } from "./episode-layout-toggle";
import { EpisodeDownloadsMenu } from "./episode-downloads-menu";
import { EpisodeSearch } from "./episode-search";
import { AnimeRandomButton } from "./anime-random-button";
import { EpisodeSearchToggle } from "./series-episodes/episode-search-controls";
import { AnimeAiBar } from "./anime-episodes/anime-ai-bar";
import { useAnimeAiSearch } from "./anime-episodes/use-anime-ai-search";
import { useAnimeProgressMap } from "./anime-episodes/use-anime-progress-map";
import { useAnimePreferredSeason } from "./anime-episodes/use-anime-preferred-season";
import { useAnimeTvdbPanel } from "./anime-episodes/use-anime-tvdb-panel";
import { animeUpToEpisodeSlice } from "./anime-episodes/up-to-episodes";

import { useFranchiseEpisodes } from "./anime-episodes/use-franchise-episodes";
import { isSoloSplitEntry } from "./anime-episodes/solo-entry";
import { animeDetails, isFranchiseExtra } from "@/lib/providers/anime-detail";
import { franchiseRoot, franchiseRootSync } from "@/lib/providers/anime-franchise-root";
import { splitFranchiseDisplaySeason } from "@/lib/streams/anime-identity-core";
import { useAnimeWatchedRouting } from "./anime-episodes/use-anime-watched-routing";
import { useAnimeFranchiseNav } from "./anime-episodes/use-anime-franchise-nav";
import { fetchEntryEpisodes } from "@/lib/providers/anime-franchise-episodes";
import { resolveTrackerAnimeEntry } from "@/lib/anime-tracker-entry";
import { useTvdbProxyImages } from "./anime-episodes/use-tvdb-proxy-images";
import { pickTvdbImage } from "@/lib/providers/tvdb-proxy";
import {
  fillAiredPlaceholderTitles,
  isPlaceholderEpisodeText,
} from "@/lib/providers/episode-placeholder";
import type { Season } from "@/lib/providers/tmdb";
import { effectiveTmdbLanguage, tmdbLanguageIso } from "@/lib/providers/tmdb/tmdb-client";
import {
  episodeArtworkFor,
  unairedIndexes,
  withEpisodeImdbRatings,
  type EpisodeArtwork,
} from "@/lib/providers/anime-episode-enrich";
import { useEntryEpisodeRatings } from "./use-episode-imdb-ratings";
import { TvdbOrderPanel } from "./series-episodes/tvdb-order-panel";
import { SeasonExplorer } from "./season-explorer";
import { useSeasonExplorerView } from "./use-season-explorer";
import { kitsuSearchAnime, parseKitsuId } from "@/lib/providers/kitsu";
import { aiIsGroq, aiKey, providerForModel } from "@/lib/ai-models";
import { animeSeasonKey } from "./anime-episodes/anime-season-key";

const STRIP_BATCH_SIZE = 60;
const LIST_BATCH_SIZE = 20;

function parseTmdbTvId(id: string): number | null {
  const m = /^tmdb:tv:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

// TVDB often lacks a still and description for an episode right after it airs;
// the order rows then fall back to the series backdrop and show no synopsis.
// TMDB (stills + overviews) and Cinemeta (stills) fill the gaps.
function useEpisodeArtwork(
  metaId: string,
  imdbId: string | null,
  tmdbKey: string,
  seasons: number[],
  enabled: boolean,
): Map<string, EpisodeArtwork> {
  const sig = seasons.join(",");
  const [art, setArt] = useState<Map<string, EpisodeArtwork>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    const list = sig ? sig.split(",").map(Number) : [];
    if (!imdbId?.startsWith("tt") && parseTmdbTvId(metaId) == null) return;
    let cancelled = false;
    void episodeArtworkFor({
      imdbId,
      tmdbId: parseTmdbTvId(metaId),
      tmdbKey,
      seasons: list,
    }).then((map) => {
      if (!cancelled) setArt(map);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, metaId, imdbId, tmdbKey, sig]);
  return art;
}

export const AnimeEpisodes = memo(function AnimeEpisodes({
  meta,
  episodes,
  franchise,
  currentId,
  scrollRef,
  trackId,
  imdbId,
  episodeHint,
  localizedOverview,
  seasonOverviews,
  tmdbTvId,
  tmdbSeasons,
  seasonPosters,
  onSeasonArt,
  onCanonicalEntry,
}: {
  meta: Meta;
  episodes: KitsuEpisode[];
  franchise: FranchiseEntry[];
  currentId: string;
  scrollRef: React.RefObject<HTMLElement | null>;
  trackId?: string;
  imdbId?: string | null;
  episodeHint?: { season: number; episode: number };
  localizedOverview?: string;
  seasonOverviews?: Record<number, string>;
  tmdbTvId?: number;
  tmdbSeasons?: Season[];
  seasonPosters?: Record<number, string>;
  onSeasonArt?: (sel: SeasonArtSelection | null) => void;
  onCanonicalEntry?: (entryId: string | null, requiresSeasonOwner: boolean) => void;
}) {
  const t = useT();
  const { isConnected: traktConnected } = useTrakt();
  const [traktWatched, setTraktWatched] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!traktConnected) {
      setTraktWatched(new Set());
      return;
    }
    let cancelled = false;
    fetchWatchedKeySet()
      .then((set) => {
        if (!cancelled) setTraktWatched(set);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [traktConnected]);

  const { watchedKeys: anilistWatched, completed: anilistCompleted } = useAnilistWatched(
    trackId ?? meta.id,
    episodes,
  );
  const { watchedKeys: malWatched, completed: malCompleted } = useMalWatched(
    trackId ?? meta.id,
    episodes,
  );
  const { isConnected: pmdbConnected } = usePublicMetaDb();
  const [pmdbWatched, setPmdbWatched] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!pmdbConnected) {
      setPmdbWatched(new Set());
      return;
    }
    let cancelled = false;
    resolvePmdbTarget(meta.id, "series")
      .then((target) => target ?? (trackId ? resolvePmdbTarget(trackId, "series") : null))
      .then((target) => {
        if (cancelled) return;
        return fetchPmdbWatchedKeySet(target ?? undefined);
      })
      .then((set) => {
        if (!cancelled && set) setPmdbWatched(set);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pmdbConnected, meta.id, trackId]);
  // Split-franchise sequels (TYBW, Stone Wars, …) render standalone: only the
  // opened entry's episodes, no sibling pooling, no whole-series TVDB buckets.
  const [rootEntryId, setRootEntryId] = useState<string | null>(() => franchiseRootSync(meta.id));
  useEffect(() => {
    let cancelled = false;
    setRootEntryId(franchiseRootSync(meta.id));
    if (rootEntryId != null) return;
    franchiseRoot(meta.id)
      .then((r) => {
        if (!cancelled) setRootEntryId(r);
      })
      .catch(() => {
        if (!cancelled) setRootEntryId(meta.id);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.id]);
  // A TYBW cour is known synchronously from its Kitsu id. Do not wait for the
  // async franchise root: that first render pools the whole Bleach franchise and
  // briefly shows the 2004 seasons before switching back.
  const soloEntry = isSoloSplitEntry(meta.id, rootEntryId);
  const franchiseEpisodes = useFranchiseEpisodes(
    franchise,
    currentId,
    episodes,
    franchise.length > 1 && !soloEntry,
  );
  const soloPickerFranchise = useMemo(
    () => franchise.filter((f) => f.meta.id !== rootEntryId && !isFranchiseExtra(f)),
    [franchise, rootEntryId],
  );
  const pickerFranchise =
    soloEntry && soloPickerFranchise.length > 0 ? soloPickerFranchise : franchise;
  const panelPool = franchiseEpisodes !== episodes ? franchiseEpisodes : undefined;
  const mwVersion = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const progressSeasonKey = useAnimePreferredSeason({
    episodes: panelPool ?? episodes,
    metaId: meta.id,
    trackId,
    traktWatched,
    anilistWatched,
    malWatched,
    pmdbWatched,
    mwVersion,
  });
  const catalogResume = useMemo(() => {
    if (!imdbId || soloEntry) return null;
    const catalog = lastPlayedEpisode(imdbId);
    if (!catalog) return null;
    const latestEntryTime = Math.max(
      lastPlayedEpisode(meta.id)?.t ?? 0,
      lastPlayedEpisode(currentId)?.t ?? 0,
    );
    return catalog.t >= latestEntryTime ? catalog : null;
  }, [imdbId, soloEntry, meta.id, currentId]);
  const preferredSeasonKey = catalogResume ? String(catalogResume.season) : progressSeasonKey;
  // Preferred season must stay reactive to watched-data arrival (trakt/AniList/MAL
  // load after first paint with empty sets). Do not latch it: latching the first
  // value sticks Season 1 computed before progress loads and blocks navigation.
  const intentSeasonKey = useMemo(() => {
    const partScoped = splitFranchiseDisplaySeason(parseKitsuId(meta.id)) != null;
    const counts = new Map<number, number>();
    for (const ep of episodes) {
      if (ep.sourceMetaId != null) continue;
      const s = partScoped ? (ep.seasonNumber ?? ep.imdbSeason) : ep.imdbSeason;
      if (s == null || s < 1) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = 0;
    if (counts.size <= 1) {
      for (const [s, n] of counts) {
        if (n > bestN) {
          best = s;
          bestN = n;
        }
      }
    }
    if (best != null && best >= 2) return String(best);
    if (episodeHint && episodeHint.season >= 2) return String(episodeHint.season);
    return null;
  }, [episodes, episodeHint]);
  const { settings, update } = useSettings();
  const routing = useAnimeWatchedRouting(meta, franchise, trackId);
  const { openMeta } = useView();
  const [activeEntryId, setActiveEntryId] = useState(currentId);
  useEffect(() => {
    setActiveEntryId(currentId);
  }, [currentId, meta.id]);
  const activeIsAnchor = activeEntryId === currentId;
  const onSelectEntry = useCallback(
    (entryId: string) => {
      if (entryId === currentId) {
        setActiveEntryId(currentId);
        return;
      }
      const entry = franchise.find((f) => f.meta.id === entryId);
      if (!entry) return;
      const inPool =
        parseKitsuId(entry.meta.id) != null &&
        franchiseEpisodes.some((ep) => ep.sourceMetaId === entryId);
      if (inPool) setActiveEntryId(entryId);
      else openMeta(entry.meta, { exact: true, seasonScrollTop: scrollRef.current?.scrollTop });
    },
    [currentId, franchise, franchiseEpisodes, openMeta, scrollRef],
  );
  const entryEpisodes = useMemo(
    () =>
      activeIsAnchor
        ? episodes
        : franchiseEpisodes.filter((ep) => ep.sourceMetaId === activeEntryId),
    [activeIsAnchor, franchiseEpisodes, activeEntryId, episodes],
  );
  const tvdbPanel = useAnimeTvdbPanel(
    parseKitsuId(meta.id),
    imdbId ?? null,
    episodes,
    settings.tvdbSeasonType,
    settings.tvdbKey,
    tvdbPanelEnabled(settings) && !soloEntry,
    panelPool,
    preferredSeasonKey ?? undefined,
    intentSeasonKey ?? undefined,
    franchise,
    meta.id,
  );
  const order = useAnimeOrder(
    imdbId ?? null,
    meta.id,
    episodes,
    effectiveOrderProvider(settings),
    settings.tvdbSeasonType,
    settings.tvdbKey,
    preferredSeasonKey ?? undefined,
    intentSeasonKey ?? undefined,
    soloEntry,
    !tvdbPanel.active,
  );
  const effectiveOrder = order;

  const onSeasonArtRef = useRef(onSeasonArt);
  onSeasonArtRef.current = onSeasonArt;
  const tvdbActiveSeason = tvdbPanel.panel
    ? tvdbPanel.panel.items.find((i) => i.key === tvdbPanel.panel!.activeKey)
    : undefined;
  const seasonEntry = useMemo(
    () => mapSeasonToEntry(tvdbActiveSeason, franchise, currentId),
    [tvdbActiveSeason, franchise, currentId],
  );
  const seasonHint = useMemo(() => {
    if (tvdbPanel.panel?.activeType === "aired" && tvdbActiveSeason?.seasonNumber != null)
      return tvdbActiveSeason.seasonNumber;
    const pool = tvdbPanel.panel?.visibleEpisodes ?? effectiveOrder?.visibleEpisodes ?? episodes;
    for (const episode of pool) {
      const season = episode.imdbSeason ?? episode.seasonNumber;
      if (season != null && season > 0) return season;
    }
    return null;
  }, [tvdbActiveSeason, tvdbPanel.panel, effectiveOrder?.visibleEpisodes, episodes]);
  const premiereEntry = useMemo(() => {
    if (
      tvdbPanel.panel?.activeType !== "aired" ||
      !tvdbActiveSeason?.seasonNumber ||
      !tvdbActiveSeason.from
    )
      return null;
    const premiere = Date.parse(tvdbActiveSeason.from);
    const candidates = franchise.filter(
      (entry) =>
        parseKitsuId(entry.meta.id) != null &&
        entry.startDate &&
        Math.abs(Date.parse(entry.startDate) - premiere) <= 7 * 86_400_000,
    );
    return candidates.length === 1 ? candidates[0].meta : null;
  }, [tvdbPanel.panel?.activeType, tvdbActiveSeason, franchise]);
  const savedSeasonEntry = useMemo(() => {
    if (!imdbId || catalogResume?.season !== seasonHint) return null;
    const id = getAnimeCwId(imdbId);
    return id && parseKitsuId(id) != null && id !== currentId
      ? { id, type: "series" as const, name: meta.name }
      : null;
  }, [imdbId, catalogResume, seasonHint, currentId, meta.name]);
  const seasonLookupKey = `${meta.id}:${tvdbPanel.panel?.activeKey ?? ""}`;
  const needsSeasonLookup =
    Boolean(tvdbPanel.panel && tvdbActiveSeason && !tvdbActiveSeason.isGenericName) &&
    !premiereEntry &&
    !savedSeasonEntry &&
    !seasonEntry;
  const [searchedSeason, setSearchedSeason] = useState<{ key: string; id: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!needsSeasonLookup || !tvdbActiveSeason?.name) return;
    let cancelled = false;
    const key = seasonLookupKey;
    void kitsuSearchAnime(`${meta.name} ${tvdbActiveSeason.name}`, 12, true)
      .then((hits) => {
        if (!cancelled)
          setSearchedSeason({
            key,
            id: matchingKitsuSeasonEntry(hits, meta.name, tvdbActiveSeason.name, tvdbActiveSeason.year),
          });
      })
      .catch(() => {
        if (!cancelled) setSearchedSeason({ key, id: null });
      });
    return () => {
      cancelled = true;
    };
  }, [needsSeasonLookup, seasonLookupKey, tvdbActiveSeason?.name, tvdbActiveSeason?.year, meta.name]);
  const searchedSeasonId = searchedSeason?.key === seasonLookupKey ? searchedSeason.id : null;
  const searchedSeasonEntry = useMemo(
    () =>
      searchedSeasonId
        ? { id: searchedSeasonId, type: "series" as const, name: `${meta.name}: ${tvdbActiveSeason?.name}` }
        : null,
    [searchedSeasonId, meta.name, tvdbActiveSeason?.name],
  );
  const visibleFirstOwner = tvdbPanel.panel?.visibleEpisodes.find(
    (ep) => ep.imdbSeason === seasonHint && ep.imdbEpisode === 1,
  )?.sourceMetaId;
  // Resolve the selected provider season independently of franchise navigation:
  // the picker can stay on the same page while its episode owner changes.
  const [nativeSeason, setNativeSeason] = useState<{
    page: string;
    season: number;
    episodes: KitsuEpisode[];
  } | null>(null);
  useEffect(() => {
    if (seasonHint == null || seasonHint < 1 || (!tvdbPanel.panel && !activeIsAnchor)) return;
    let cancelled = false;
    // A named TVDB season may belong to a newer cour missing from `franchise`.
    // Wait for the safely matched search result before using a generic tracker fallback.
    if (needsSeasonLookup && searchedSeason?.key !== seasonLookupKey) return;
    const selectedEntry = premiereEntry ?? savedSeasonEntry ?? searchedSeasonEntry;
    if (selectedEntry && selectedEntry.id !== currentId) {
      const publish = (rows: KitsuEpisode[], id: number) => {
        if (cancelled || !rows.length || selectedEntry.id !== `kitsu:${id}`) return;
        // A candidate from resume, search, or premiere metadata is not the
        // tracker owner until its actual episodes match the selected show.
        if (!rows.some((ep) => ep.imdbId === imdbId && ep.imdbSeason === seasonHint))
          return;
        setNativeSeason({
          page: meta.id,
          season: seasonHint,
          episodes: rows.map((ep) => ({
            ...ep,
            sourceMetaId: ep.sourceMetaId ?? selectedEntry.id,
          })),
        });
      };
      void animeDetails(settings, selectedEntry, publish)
        .then((result) => {
          if (!result || cancelled) return;
          publish(result.episodes, result.kitsuId);
          void result.enrichPromise.then((rows) => publish(rows, result.kitsuId)).catch(() => {});
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    const mappedOwners = new Set(
      franchiseEpisodes
        .filter((ep) => ep.imdbSeason === seasonHint && ep.imdbEpisode === 1)
        .map((ep) => ep.sourceMetaId ?? ep.streamId?.match(/^(kitsu:\d+):\d+$/)?.[1] ?? currentId)
        .filter((id) => parseKitsuId(id) != null),
    );
    const mappedId = visibleFirstOwner ?? (mappedOwners.size === 1 ? [...mappedOwners][0] : null);
    const ownerRequest = mappedId
      ? Promise.resolve({ id: mappedId })
      : resolveTrackerAnimeEntry(meta.id, { season: seasonHint, episode: 1 });
    void ownerRequest
      .then(async (owner) => {
        const id = owner && parseKitsuId(owner.id);
        if (cancelled || id == null) return;
        if (owner?.id === meta.id &&
            episodes.some((ep) => ep.imdbId === imdbId && ep.imdbSeason === seasonHint)) {
          if (!cancelled) setNativeSeason({ page: meta.id, season: seasonHint, episodes });
          return;
        }
        const rows = await fetchEntryEpisodes(id, settings);
        if (!cancelled && rows.some((ep) => ep.imdbId === imdbId && ep.imdbSeason === seasonHint))
          setNativeSeason({ page: meta.id, season: seasonHint, episodes: rows });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    meta.id,
    seasonHint,
    activeIsAnchor,
    Boolean(tvdbPanel.panel),
    visibleFirstOwner,
    premiereEntry,
    savedSeasonEntry,
    searchedSeasonEntry,
    searchedSeason,
    seasonLookupKey,
    needsSeasonLookup,
    imdbId,
    settings,
    franchiseEpisodes,
    currentId,
    episodes,
  ]);
  // The matched franchise entry's episodes carry their TMDB season number (AniZip), which selects
  // the right localized per-season overview so the hero changes per season instead of staying static.
  const seasonOverview = useMemo(() => {
    if (!seasonEntry || !seasonOverviews) return undefined;
    const counts = new Map<number, number>();
    for (const ep of franchiseEpisodes) {
      if (ep.sourceMetaId !== seasonEntry.meta.id || ep.imdbSeason == null) continue;
      counts.set(ep.imdbSeason, (counts.get(ep.imdbSeason) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = 0;
    for (const [s, n] of counts) {
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    return best != null ? seasonOverviews[best] : undefined;
  }, [seasonEntry, seasonOverviews, franchiseEpisodes]);
  useEffect(() => {
    onSeasonArtRef.current?.(
      seasonEntry
        ? {
            background: seasonEntry.meta.background,
            description: seasonOverview ?? localizedOverview ?? seasonEntry.meta.description,
            logo: seasonEntry.meta.logo,
            name: seasonEntry.meta.name,
            entryId: seasonEntry.meta.id,
          }
        : null,
    );
  }, [seasonEntry, localizedOverview, seasonOverview]);
  useEffect(() => () => onSeasonArtRef.current?.(null), []);
  const proxyImages = useTvdbProxyImages(
    parseKitsuId(meta.id),
    imdbId ?? null,
    episodes.length,
    "aired",
  );
  const entrySeason =
    episodes.find((ep) => ep.imdbId === imdbId && ep.imdbSeason != null)?.imdbSeason ??
    episodes.find((ep) => ep.imdbSeason != null)?.imdbSeason ??
    null;
  const selectedWork = premiereEntry ?? savedSeasonEntry ?? searchedSeasonEntry;
  const seasonTitle =
    selectedWork && selectedWork.id !== currentId && !tvdbActiveSeason?.isGenericName
      ? tvdbActiveSeason?.name
      : undefined;
  const yearMatch = /(\d{4})/.exec(
    (seasonTitle && tvdbActiveSeason?.year) || meta.releaseInfo || "",
  );
  const { ratings, season: ratingSeason } = useEntryEpisodeRatings(
    imdbId ?? null,
    seasonHint ?? entrySeason,
    seasonTitle ?? selectedWork?.name ?? meta.name ?? null,
    yearMatch ? Number(yearMatch[1]) : null,
  );
  const unratedDisplay = tvdbPanel.panel
    ? tvdbPanel.panel.visibleEpisodes
    : !activeIsAnchor
      ? entryEpisodes
      : effectiveOrder
        ? effectiveOrder.visibleEpisodes
        : episodes;
  const selectedRows = useMemo(() => {
    if (!nativeSeason || nativeSeason.page !== meta.id || nativeSeason.season !== seasonHint)
      return unratedDisplay;
    if (!tvdbPanel.panel && !activeIsAnchor) return unratedDisplay;
    return nativeSeasonRows(unratedDisplay, nativeSeason.episodes, nativeSeason.season);
  }, [nativeSeason, meta.id, seasonHint, unratedDisplay, tvdbPanel.panel, activeIsAnchor]);
  const ratingOwner = selectedRows[0]?.sourceMetaId ?? meta.id;
  const baseDisplay = useMemo(
    () =>
      withEpisodeImdbRatings(selectedRows, ratings, {
        seriesMetaId: ratingOwner,
        seriesImdbId: imdbId ?? null,
        ratingSeason,
      }),
    [selectedRows, ratings, ratingOwner, imdbId, ratingSeason],
  );
  const artworkSeasons = useMemo(
    () => [
      ...new Set(
        baseDisplay
          .map((e) => e.imdbSeason ?? e.seasonNumber)
          .filter((s): s is number => s != null && s > 0),
      ),
    ],
    [baseDisplay],
  );
  const artworkNeeded = useMemo(
    () =>
      baseDisplay.some(
        (e) => !e.thumbnail || !e.synopsis?.trim() || isPlaceholderEpisodeText(e.synopsis),
      ),
    [baseDisplay],
  );
  const artwork = useEpisodeArtwork(
    meta.id,
    imdbId ?? null,
    settings.tmdbKey,
    artworkSeasons,
    artworkNeeded,
  );
  // Only rows with a known future date are provably unaired and skip artwork /
  // badge as upcoming. A merely undated row past the aired frontier may have
  // aired, so it keeps its still and is not marked upcoming.
  const unairedIds = useMemo(() => {
    const ids = new Set<number>();
    unairedIndexes(baseDisplay).forEach((i) => {
      const ep = baseDisplay[i];
      if (ep.airdate && isUpcomingDate(ep.airdate)) ids.add(ep.id);
    });
    return ids;
  }, [baseDisplay]);
  const displayEpisodes = useMemo(() => {
    // The TVDB order can still say "TBA" for an episode that already aired while
    // the entry's own episodes know the real title; fill those in, keep TBA for
    // episodes that have not aired. Missing stills and descriptions come from
    // the artwork map (TMDB first, then Cinemeta).
    const filled = fillAiredPlaceholderTitles(
      baseDisplay,
      franchiseEpisodes,
      Date.now(),
      tmdbLanguageIso(),
    );
    let changed = false;
    const out = filled.map((ep) => {
      // An episode that has not aired has no real still or description
      // anywhere yet, so any artwork-map hit would be another season's data
      // borrowed through a differently-numbered provider season.
      if (unairedIds.has(ep.id)) return ep;
      const img = pickTvdbImage(proxyImages, ep, { preferAbsolute: soloEntry });
      if (img) {
        changed = true;
        return {
          ...ep,
          thumbnail: img,
          thumbnailFallback:
            img !== ep.thumbnail ? (ep.thumbnail ?? ep.thumbnailFallback) : ep.thumbnailFallback,
        };
      }
      const pair =
        ep.imdbSeason != null && ep.imdbEpisode != null
          ? `${ep.imdbSeason}:${ep.imdbEpisode}`
          : null;
      const art = pair ? artwork.get(pair) : undefined;
      let next = ep;
      if (!next.thumbnail && art?.thumbnail) {
        next = { ...next, thumbnail: art.thumbnail };
        changed = true;
      }
      if ((!next.synopsis?.trim() || isPlaceholderEpisodeText(next.synopsis)) && art?.synopsis) {
        next = { ...next, synopsis: art.synopsis };
        changed = true;
      }
      if (!next.length && art?.runtime) {
        next = { ...next, length: art.runtime };
        changed = true;
      }
      return next;
    });
    return changed ? out : filled;
  }, [baseDisplay, proxyImages, franchiseEpisodes, artwork, unairedIds, soloEntry]);
  const displaySourceId = useMemo(() => {
    const ids = new Set<string>();
    for (const e of displayEpisodes) if (e.sourceMetaId != null) ids.add(e.sourceMetaId);
    return ids.size === 1 ? [...ids][0] : null;
  }, [displayEpisodes]);
  // Never show the opened base entry's status for another season while its
  // actual owner is unresolved. Saved, searched and premiere candidates are
  // not proof; the selected provider episodes must independently match IMDb.
  const requiresSeasonOwner =
    !activeIsAnchor ||
    Boolean(tvdbPanel.panel && seasonHint != null && seasonHint !== (entrySeason ?? 1));
  const nativeOwner = nativeSeasonOwnerId(nativeSeason, meta.id, seasonHint);
  const verifiedNativeOwner = nativeOwner &&
    verifiedSeasonOwnerFromEpisodes(nativeSeason?.episodes ?? [], imdbId, seasonHint) === nativeOwner
      ? nativeOwner : null;
  const verifiedDisplayOwner = verifiedSeasonOwnerFromEpisodes(displayEpisodes, imdbId, seasonHint);
  const selectedCanonicalEntryId = tvdbPanel.panel
    ? (verifiedNativeOwner ?? verifiedDisplayOwner ??
       (requiresSeasonOwner ? null : displaySourceId ?? activeEntryId))
    : displaySourceId ?? (activeIsAnchor ? null : activeEntryId);
  useEffect(() => {
    onCanonicalEntry?.(selectedCanonicalEntryId, requiresSeasonOwner);
  }, [selectedCanonicalEntryId, requiresSeasonOwner, onCanonicalEntry]);
  useEffect(() => () => onCanonicalEntry?.(null, false), [onCanonicalEntry]);
  const entryPoolEpisodes = useMemo(
    () =>
      displaySourceId && nativeSeason?.episodes[0]?.sourceMetaId === displaySourceId
        ? nativeSeason.episodes
        : displaySourceId
          ? franchiseEpisodes.filter((e) => e.sourceMetaId === displaySourceId)
          : [],
    [displaySourceId, franchiseEpisodes, nativeSeason],
  );
  const { watchedKeys: entryAnilistWatched } = useAnilistWatched(
    displaySourceId ?? "",
    entryPoolEpisodes,
  );
  const { watchedKeys: entryMalWatched } = useMalWatched(displaySourceId ?? "", entryPoolEpisodes);
  const showSeason = useMemo(
    () =>
      new Set(displayEpisodes.map((e) => e.displaySeason ?? e.seasonNumber ?? e.imdbSeason ?? 1))
        .size > 1,
    [displayEpisodes],
  );
  const { pickerItems, selectPickerItem, franchiseActiveKey } = useAnimeFranchiseNav(
    effectiveOrder,
    franchise,
    currentId,
    activeEntryId,
    onSelectEntry,
  );
  const [watchedMenu, setWatchedMenu] = useState<WatchedMenuTarget | null>(null);
  const openWatchedMenu = (
    e: React.MouseEvent,
    season: number,
    episode: number,
    watched: boolean,
    sourceMetaId?: string,
    absoluteNumber?: number,
  ) => {
    e.preventDefault();
    const selected = displayEpisodes.find(
      (ep) =>
        animeSeasonKey(ep) === season &&
        ep.number === episode &&
        (ep.sourceMetaId ?? meta.id) === (sourceMetaId ?? meta.id) &&
        (absoluteNumber === undefined || ep.absoluteNumber === absoluteNumber),
    );
    setWatchedMenu({
      x: e.clientX,
      y: e.clientY,
      season,
      episode,
      watched,
      queueTarget: selected
        ? {
            meta: routing.metaForEp(selected),
            episode: {
              season: animeSeasonKey(selected),
              episode: selected.number,
              name: selected.title,
              still: selected.thumbnail ?? undefined,
              overview: selected.synopsis || undefined,
              kitsuStreamId: selected.streamId,
              imdbId: selected.imdbId,
              imdbSeason: selected.imdbSeason,
              imdbEpisode: selected.imdbEpisode,
              absoluteNumber: selected.absoluteNumber ?? selected.number,
              tvdbEpisodeId: selected.tvdbEpisodeId,
              sourceMetaId: selected.sourceMetaId,
            },
          }
        : undefined,
      metaId: sourceMetaId,
      absoluteNumber,
      origin: e.currentTarget instanceof HTMLElement ? e.currentTarget : null,
    });
  };

  const { progressFor, nextUpNum, nextUpId, spoilerFor, allWatched } = useAnimeProgressMap({
    episodes,
    displayEpisodes,
    metaId: meta.id,
    trackId,
    traktWatched,
    anilistWatched,
    malWatched,
    pmdbWatched,
    entrySourceId: displaySourceId,
    entryAnilistWatched,
    entryMalWatched,
    mwVersion,
    settings,
  });
  const markSeason = (watched: boolean) => routing.markMany(displayEpisodes, watched);
  // Cours share the season page but not a source entry, so mark the displayed
  // order through the clicked card and write each entry's own watched keys.
  const watchedMenuUpTo = watchedMenu
    ? airedOnly(animeUpToEpisodeSlice(displayEpisodes, meta.id, watchedMenu), (ep) => ep.airdate)
    : [];

  const orderedEpisodes = useMemo(
    () => (settings.episodeSort === "newest" ? displayEpisodes.slice().reverse() : displayEpisodes),
    [displayEpisodes, settings.episodeSort],
  );
  const windowed = settings.episodeLayout === "list" || settings.episodeLayout === "strip";
  const batchSize = settings.episodeLayout === "list" ? LIST_BATCH_SIZE : STRIP_BATCH_SIZE;
  const [renderCount, setRenderCount] = useState(batchSize);
  useEffect(() => {
    setRenderCount(batchSize);
  }, [meta.id, settings.episodeLayout, settings.episodeSort, activeEntryId, batchSize]);
  const onPickerSelect = useCallback(
    (key: string) => {
      setRenderCount(batchSize);
      selectPickerItem(key);
    },
    [selectPickerItem, batchSize],
  );
  const onTvdbSelect = useCallback(
    (key: string) => {
      setRenderCount(batchSize);
      tvdbPanel.panel?.onSelect(key);
    },
    [tvdbPanel.panel?.onSelect, batchSize],
  );
  const grow = useCallback(
    () =>
      setRenderCount((c) =>
        c >= orderedEpisodes.length ? c : Math.min(orderedEpisodes.length, c + batchSize),
      ),
    [orderedEpisodes.length, batchSize],
  );
  const reveal = useCallback(
    (n: number, epId?: number | null) => {
      const byId = epId != null ? orderedEpisodes.findIndex((e) => e.id === epId) : -1;
      const idx = byId >= 0 ? byId : orderedEpisodes.findIndex((e) => e.number === n);
      const target = idx >= 0 ? idx : n;
      setRenderCount((c) => Math.max(c, Math.min(orderedEpisodes.length, target + 20)));
    },
    [orderedEpisodes],
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listEpisodes = windowed ? orderedEpisodes.slice(0, renderCount) : orderedEpisodes;

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const aiProvider = providerForModel(settings.aiSearchModel);
  const ai = useAnimeAiSearch(
    meta.name,
    displayEpisodes,
    aiKey(settings),
    settings.aiSearchModel,
    aiIsGroq(settings),
  );
  const filteredEpisodes = useMemo(() => {
    if (aiMode && ai.matched) return displayEpisodes.filter((e) => ai.matched!.has(e.number));
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return displayEpisodes.filter(
      (e) =>
        String(e.displayNumber ?? e.number).includes(q) ||
        String(e.number).includes(q) ||
        (e.title ?? "").toLowerCase().includes(q),
    );
  }, [query, displayEpisodes, aiMode, ai.matched]);
  const gridEpisodes = filteredEpisodes ?? displayEpisodes;
  const windowEpisodes = filteredEpisodes
    ? settings.episodeSort === "newest"
      ? filteredEpisodes.slice().reverse()
      : filteredEpisodes
    : listEpisodes;
  const hasMore = windowed && renderCount < orderedEpisodes.length;
  const showSentinel = settings.episodeLayout === "list" && hasMore && !filteredEpisodes;
  useEffect(() => {
    if (!showSentinel) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) startTransition(grow);
      },
      { root: scrollRef.current ?? null, rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showSentinel, grow, scrollRef]);

  const didJumpRef = useRef("");
  useEffect(() => {
    if (order || tvdbPanel.panel) return;
    if (nextUpNum == null || didJumpRef.current === meta.id) return;
    const idx = episodes.findIndex((ep) => ep.id === nextUpId);
    if (idx < 12) return;
    didJumpRef.current = meta.id;
    if ((scrollRef.current?.scrollTop ?? 0) > 240) return;
    reveal(nextUpNum, nextUpId);
    scrollToDataEp(scrollRef.current, nextUpNum, {
      behavior: "auto",
      center: true,
      epId: nextUpId,
    });
  }, [nextUpNum, nextUpId, episodes, meta.id, reveal, scrollRef]);

  const isOneOff = meta.type === "movie" || episodes.length <= 1;
  const downloadEpisodes = useMemo(
    () =>
      displayEpisodes.map((e) => ({
        season: e.seasonNumber || 1,
        episode: e.number,
        name: e.title || undefined,
        kitsuStreamId: e.streamId,
        imdbId: e.imdbId,
        imdbSeason: e.imdbSeason,
        imdbEpisode: e.imdbEpisode,
        tvdbEpisodeId: e.tvdbEpisodeId,
      })),
    [displayEpisodes],
  );
  const explorerPicker = tvdbPanel.panel ?? (activeIsAnchor ? effectiveOrder : null);
  const explorerType =
    tvdbPanel.panel?.activeType ??
    (effectiveOrderProvider(settings) === "tvdb" ? settings.tvdbSeasonType : "aired");

  const showExplorer =
    settings.tvdbSeasonExplorer !== false &&
    !isOneOff &&
    !soloEntry &&
    !!explorerPicker &&
    !["absolute", "tvdbabsolute"].includes(explorerType);
  const tmdbSeasonByNumber = useMemo(
    () => new Map((tmdbSeasons ?? []).map((season) => [season.seasonNumber, season])),
    [tmdbSeasons],
  );
  // TMDB numbers seasons differently in DVD/regional orders, so its metadata
  // is only safe to borrow for aired/official views.
  const tmdbSeasonFallback = explorerType === "aired" || explorerType === "official";
  const explorerItems = useMemo(
    () =>
      (tvdbPanel.panel?.items ?? pickerItems).map((item) => {
        if (!tmdbSeasonFallback) return item;
        const seasonNumber = item.seasonNumber;
        if (seasonNumber == null) return item;
        const tmdb = tmdbSeasonByNumber.get(seasonNumber);
        if (!tmdb) return item;
        return {
          ...item,
          fallbackName: tmdb.nameLanguage === "en" || !tmdb.nameLanguage ? tmdb.name : undefined,
          overview: item.overview || tmdb.overview,
          overviewLanguage: item.overview ? item.overviewLanguage : tmdb.overviewLanguage,
          poster: item.poster || seasonPosters?.[seasonNumber],
        };
      }),
    [tvdbPanel.panel?.items, pickerItems, tmdbSeasonByNumber, tmdbSeasonFallback, seasonPosters],
  );
  const explorer = useSeasonExplorerView({
    metaId: meta.id,
    imdbId,
    tvdbKey: settings.tvdbKey,
    tmdbKey: settings.tmdbKey,
    tmdbTvId,
    seasonPosters,
    titlePoster: meta.poster,
    seasonType: explorerType === "aired" ? "official" : explorerType,
    lang: effectiveTmdbLanguage(),
    items: explorerItems,
    activeKey: tvdbPanel.panel?.activeKey ?? franchiseActiveKey ?? explorerPicker?.activeKey ?? "",
    enabled: showExplorer,
    allowProxy: true,
  });

  return (
    <div data-anime-episodes className="flex flex-col gap-6 scroll-mt-24">
      {showExplorer && explorerPicker && (
        <SeasonExplorer
          key={`${meta.id}:${explorerType}`}
          data={explorer}
          background={meta.background}
          activeKey={tvdbPanel.panel?.activeKey ?? franchiseActiveKey ?? explorerPicker.activeKey}
          onSelect={tvdbPanel.panel ? onTvdbSelect : onPickerSelect}
        />
      )}
      <div data-scroll-anchor="detail-episodes" className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <h3 className="shrink-0 pt-1 text-[22px] font-medium tracking-tight text-ink">
            {isOneOff ? t("Movie") : t("Episodes")}
          </h3>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 xl:gap-3">
            {!isOneOff && (
              <p className="hidden text-[13px] text-ink-subtle 2xl:block">
                {displayEpisodes.length === 1
                  ? t("{n} episode", { n: displayEpisodes.length })
                  : t("{n} episodes", { n: displayEpisodes.length })}
              </p>
            )}
            {!isOneOff && <EpisodeDownloadsMenu meta={meta} episodes={downloadEpisodes} />}
            {!isOneOff && (
              <AnimeRandomButton episodes={displayEpisodes} metaForEp={routing.metaForEp} />
            )}
            {!isOneOff && (
              <EpisodeLayoutToggle
                value={settings.episodeLayout}
                onChange={(v) => update({ episodeLayout: v })}
              />
            )}
            {!isOneOff && (
              <EpisodeGridControls
                sort={settings.episodeSort}
                onSort={(s) => update({ episodeSort: s })}
                allWatched={allWatched}
                onMarkSeason={markSeason}
              />
            )}
            {!isOneOff && (
              <EpisodeSearchToggle
                searchActive={searchOpen || query.trim().length > 0}
                aiMode={aiMode}
                aiEnabled={!!(settings.aiSearchKey.trim() || settings.aiGroqKey.trim())}
                aiProvider={aiProvider}
                onSearch={() => {
                  setSearchOpen((v) => !v);
                  setAiMode(false);
                  ai.reset();
                }}
                onAskAi={() => {
                  setAiMode(true);
                  setSearchOpen(false);
                  setQuery("");
                }}
              />
            )}
            {isOneOff ? (
              franchise.length > 1 ? (
                <AnimeSeasonPicker
                  franchise={pickerFranchise}
                  activeEntryId={activeEntryId}
                  onSelectEntry={onSelectEntry}
                />
              ) : null
            ) : tvdbPanel.panel ? (
              <TvdbOrderPanel
                items={explorer.items}
                activeKey={tvdbPanel.panel.activeKey}
                onSelect={onTvdbSelect}
                orderTypes={tvdbPanel.panel.orderTypes}
                activeType={tvdbPanel.panel.activeType}
                onSelectType={(v) =>
                  update({ tvdbSeasonType: v as typeof settings.tvdbSeasonType })
                }
              />
            ) : tvdbPanel.active ? (
              <div aria-hidden className="h-10 w-44 animate-pulse rounded-full bg-white/[0.06]" />
            ) : effectiveOrder ? (
              <SeasonArcPicker
                items={explorer.items}
                activeKey={franchiseActiveKey ?? effectiveOrder.activeKey}
                onSelect={onPickerSelect}
              />
            ) : franchise.length > 1 ? (
              <AnimeSeasonPicker
                franchise={pickerFranchise}
                activeEntryId={activeEntryId}
                onSelectEntry={onSelectEntry}
              />
            ) : null}
          </div>
        </div>
        {!isOneOff && aiMode && (
          <AnimeAiBar
            provider={aiProvider}
            loading={ai.status === "loading"}
            onSubmit={ai.run}
            onExit={() => {
              setAiMode(false);
              ai.reset();
            }}
          />
        )}
        {!isOneOff && !aiMode && searchOpen && (
          <EpisodeSearch
            query={query}
            onQuery={setQuery}
            matched={filteredEpisodes?.length ?? null}
          />
        )}
      </div>
      {isOneOff ? (
        <MovieEntryCard meta={meta} ep={episodes[0]} watched={anilistCompleted || malCompleted} />
      ) : (
        <div key={settings.episodeLayout} className="animate-fade-in">
          {filteredEpisodes && filteredEpisodes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <p className="text-[14px] text-ink-muted">{t("No episodes match your search")}</p>
              <button
                onClick={() => setQuery("")}
                className="text-[13px] font-medium text-accent transition-opacity hover:opacity-80"
              >
                {t("Clear search")}
              </button>
            </div>
          ) : settings.episodeLayout === "list" ? (
            <div className="flex flex-col gap-1">
              {windowEpisodes.map((ep) => (
                <AnimeEpisodeRow
                  key={ep.id}
                  meta={meta}
                  ep={ep}
                  progress={progressFor(ep)}
                  spoiler={spoilerFor(ep)}
                  onContextMenu={openWatchedMenu}
                  metaForEp={routing.metaForEp}
                  showSeason={showSeason}
                  forceUpcoming={unairedIds.has(ep.id)}
                />
              ))}
              {showSentinel && <div ref={sentinelRef} aria-hidden className="h-px w-full" />}
            </div>
          ) : (
            <AnimeEpisodeStrip
              layout={settings.episodeLayout === "grid" ? "grid" : "strip"}
              meta={meta}
              episodes={settings.episodeLayout === "grid" ? gridEpisodes : windowEpisodes}
              progressFor={progressFor}
              spoilerFor={spoilerFor}
              onContextMenu={openWatchedMenu}
              onReachEnd={settings.episodeLayout === "grid" ? undefined : grow}
              metaForEp={routing.metaForEp}
              showSeason={showSeason}
              unairedIds={unairedIds}
            />
          )}
        </div>
      )}
      {watchedMenu && (
        <EpisodeWatchedMenu
          metaId={watchedMenu.metaId ?? meta.id}
          syncMetaId={
            (watchedMenu.metaId ?? meta.id) === meta.id &&
            trackId &&
            /^(kitsu|mal|anilist|anidb):/.test(trackId) &&
            !/^(kitsu|mal|anilist|anidb):/.test(meta.id)
              ? trackId
              : undefined
          }
          meta={
            watchedMenu.metaId
              ? routing.manualMetaFor(watchedMenu.metaId)
              : {
                  type: "series",
                  name: meta.name,
                  poster: meta.poster,
                  background: meta.background,
                }
          }
          target={watchedMenu}
          upToScope={{
            count: watchedMenuUpTo.length,
            markWatched: () => routing.markMany(watchedMenuUpTo, true),
          }}
          onClose={() => setWatchedMenu(null)}
        />
      )}
    </div>
  );
});
