import { startTransition, useEffect, useState, type RefObject } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { Settings } from "@/lib/settings/types";
import { useOmdbScores, omdbPrefetch } from "@/lib/providers/omdb";
import { useCinemetaRating, cinemetaRatingPrefetch } from "@/lib/providers/cinemeta-rating";
import { useMdblistCardScores, mdblistCardPrefetch } from "@/lib/providers/mdblist-batch";
import { tmdbIdFromImdb, tmdbImdbId, useTmdbVote } from "@/lib/providers/tmdb";
import { needsImdbForPoster, needsTmdbForPoster } from "@/lib/providers/rpdb";
import { useSimklCardScores, useSimklCardScoresByAnimeId } from "@/lib/simkl/ratings";
import type { CardBadge } from "@/components/card-score-stack";
import { harborImdbTitle } from "@/lib/providers/harbor-imdb";
import { isCardAnimeId } from "@/lib/card-anime";
import { observe, observeSettled } from "@/lib/visibility";
import { useProfiledEffect } from "@/components/profiled";
import { createRequestScheduler } from "@/lib/request-scheduler";
import { runAfterScroll } from "@/lib/scroll-activity";

// A row can reveal a dozen cards in one frame. The Harbor title endpoint is
// useful but not urgent, so keep its bursts serialized instead of firing one
// request per card at once.
const ratingLookups = createRequestScheduler({ concurrency: 4 });

export function useCardScoreState<T extends HTMLElement>({
  meta,
  settings,
  imdbId,
  animeImdbId,
  animeRating,
  cardRef,
  prefetchPosterIds = false,
}: {
  meta: Meta;
  settings: Settings;
  imdbId?: string;
  animeImdbId?: string;
  animeRating?: string;
  cardRef: RefObject<T | null>;
  prefetchPosterIds?: boolean;
}) {
  const isAnime = isCardAnimeId(meta.id);
  const mediaKind = meta.type === "series" ? "show" : "movie";
  const hasInlineImdb = meta.id.startsWith("tt") && !!meta.imdbRating;
  const wantCinemetaRating = settings.showImdbBadge && !isAnime && !hasInlineImdb;
  const wantAnimeImdb =
    isAnime && settings.showMalBadge && settings.animeCardRating === "imdb" && !!animeImdbId;
  const ratingTt = isAnime ? (wantAnimeImdb ? animeImdbId : undefined) : imdbId;
  const [harborRating, setHarborRating] = useState<string>();
  const wantBatchScores =
    settings.showPopcornBadge ||
    settings.showMetacriticBadge ||
    settings.showLetterboxdBadge ||
    settings.showMdblistBadge ||
    settings.showTraktBadge ||
    settings.showSimklBadge;
  const wantsOmdb = !!settings.omdbKey && (settings.showImdbBadge || settings.showRtBadge);
  const wantsMdblist = !!settings.mdblistKey && wantBatchScores;

  const omdb = useOmdbScores(imdbId);
  const cinemetaRating = useCinemetaRating(wantCinemetaRating ? imdbId : undefined);
  const animeOmdb = useOmdbScores(wantAnimeImdb ? animeImdbId : undefined);
  const animeCinemeta = useCinemetaRating(wantAnimeImdb ? animeImdbId : undefined);
  const tmdbVote = useTmdbVote(
    settings.showTmdbBadge && !isAnime ? meta.id : undefined,
    meta.type === "series" ? "series" : "movie",
    settings.tmdbKey,
  );
  const cardScores = useMdblistCardScores(wantBatchScores ? imdbId : undefined, mediaKind);
  const simklScore = useSimklCardScores(settings.showSimklBadge && !isAnime ? imdbId : undefined);
  const simklAnimeScore = useSimklCardScoresByAnimeId(
    settings.showSimklBadge && isAnime ? meta.id : undefined,
  );
  const simklValue = (isAnime ? simklAnimeScore : simklScore).score ?? cardScores?.simkl ?? null;

  useProfiledEffect(
    "card.rating",
    () => {
      setHarborRating(undefined);
      if (!ratingTt?.startsWith("tt")) return;
      if (isAnime ? !settings.showMalBadge : !settings.showImdbBadge) return;
      // A Cinemeta card (`tt` id) displays its own inline rating, so the Harbor
      // request adds nothing. A TMDB/addon card can carry an imdbRating it cannot
      // display; skipping the fallback there left the IMDb badge empty.
      if (!isAnime && hasInlineImdb) return;
      const element = cardRef.current;
      if (!element) return;
      let cancelled = false;
      const off = observeSettled(element, () => {
        ratingLookups
          .schedule(ratingTt, () => harborImdbTitle(ratingTt))
          .then((rating) => {
            if (!cancelled && rating != null) {
              runAfterScroll(() => {
                if (!cancelled) startTransition(() => setHarborRating(rating.toFixed(1)));
              });
            }
          })
          .catch(() => {});
      });
      return () => {
        cancelled = true;
        off();
      };
    },
    [ratingTt, isAnime, settings.showImdbBadge, settings.showMalBadge, cardRef, meta.imdbRating],
  );

  useEffect(() => {
    const wantTmdbPoster =
      prefetchPosterIds && needsTmdbForPoster(settings.rpdbKey, meta.id, settings.posterBaseUrl);
    const wantImdbForPoster =
      prefetchPosterIds && needsImdbForPoster(settings.rpdbKey, meta.id, settings.posterBaseUrl);
    if (
      !wantsOmdb &&
      !wantsMdblist &&
      !wantCinemetaRating &&
      !wantAnimeImdb &&
      !wantTmdbPoster &&
      !wantImdbForPoster
    )
      return;
    const element = cardRef.current;
    if (!element) return;
    const kind = meta.type === "series" ? "series" : "movie";
    const offArtwork =
      wantTmdbPoster || wantImdbForPoster
        ? observe(element, (visible) => {
            if (!visible) return;
            offArtwork?.();
            if (wantTmdbPoster) void tmdbIdFromImdb(settings.tmdbKey, meta.id, kind);
            if (wantImdbForPoster) void tmdbImdbId(settings.tmdbKey, meta.id);
          })
        : undefined;
    const needsScoreId = wantsOmdb || wantsMdblist || wantCinemetaRating || wantAnimeImdb;
    let cancelled = false;
    const offScores = needsScoreId
      ? observeSettled(element, async () => {
          const id = imdbId ?? (await tmdbImdbId(settings.tmdbKey, meta.id));
          if (cancelled) return;
          if (id) {
            if (wantsOmdb) void omdbPrefetch(settings.omdbKey, id);
            if (wantsMdblist) mdblistCardPrefetch(id, mediaKind);
            if (wantCinemetaRating) cinemetaRatingPrefetch(id, kind);
          }
          if (wantAnimeImdb && animeImdbId) {
            if (settings.omdbKey) void omdbPrefetch(settings.omdbKey, animeImdbId);
            cinemetaRatingPrefetch(animeImdbId, kind);
          }
        })
      : undefined;
    return () => {
      cancelled = true;
      offArtwork?.();
      offScores?.();
    };
  }, [
    cardRef,
    imdbId,
    animeImdbId,
    meta.id,
    meta.type,
    mediaKind,
    settings.tmdbKey,
    settings.omdbKey,
    settings.mdblistKey,
    settings.rpdbKey,
    settings.posterBaseUrl,
    settings.showImdbBadge,
    settings.showRtBadge,
    wantsOmdb,
    wantsMdblist,
    wantBatchScores,
    wantCinemetaRating,
    wantAnimeImdb,
    prefetchPosterIds,
  ]);

  const cardImdbValue = isAnime
    ? undefined
    : (harborRating ??
      omdb?.imdbRating ??
      cinemetaRating ??
      (meta.id.startsWith("tt") ? meta.imdbRating : undefined));
  const resolvedAnimeRating = wantAnimeImdb
    ? (harborRating ?? animeOmdb?.imdbRating ?? animeCinemeta ?? meta.imdbRating)
    : animeRating;
  const resolvedAnimeSource: "imdb" | "mal" =
    wantAnimeImdb && (harborRating || animeOmdb?.imdbRating || animeCinemeta) ? "imdb" : "mal";
  const cardRating = isAnime
    ? settings.showMalBadge
      ? resolvedAnimeRating
      : undefined
    : settings.showImdbBadge && cardImdbValue
      ? cardImdbValue
      : settings.showTmdbBadge && tmdbVote
        ? tmdbVote
        : undefined;

  const cardBadges: CardBadge[] = [];
  if (isAnime) {
    if (settings.showMalBadge && resolvedAnimeRating)
      cardBadges.push({ kind: "rating", source: resolvedAnimeSource, value: resolvedAnimeRating });
  } else {
    if (settings.showImdbBadge && cardImdbValue)
      cardBadges.push({ kind: "rating", source: "imdb", value: cardImdbValue });
    if (settings.showTmdbBadge && tmdbVote)
      cardBadges.push({ kind: "rating", source: "tmdb", value: tmdbVote });
  }
  if (settings.showSimklBadge && simklValue != null)
    cardBadges.push({ kind: "simkl", value: simklValue });
  if (settings.showRtBadge && omdb?.rtCritics != null)
    cardBadges.push({ kind: "rt", value: omdb.rtCritics });
  if (settings.showPopcornBadge && cardScores?.rtAudience != null)
    cardBadges.push({ kind: "audience", value: cardScores.rtAudience });
  if (settings.showMetacriticBadge && cardScores?.metacritic != null)
    cardBadges.push({ kind: "metacritic", value: cardScores.metacritic });
  if (settings.showLetterboxdBadge && cardScores?.letterboxd != null)
    cardBadges.push({ kind: "letterboxd", value: cardScores.letterboxd });
  if (settings.showMdblistBadge && cardScores?.score != null)
    cardBadges.push({ kind: "mdblist", value: cardScores.score });
  if (settings.showTraktBadge && cardScores?.trakt != null)
    cardBadges.push({ kind: "trakt", value: cardScores.trakt });

  return { cardRating, cardBadges };
}
