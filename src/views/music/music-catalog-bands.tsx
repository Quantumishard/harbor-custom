import { MusicCatalogRow } from "@/components/music/music-catalog-row";
import { MusicConnectCard } from "@/components/music/music-connect-card";
import { ytmLikedPlaylist } from "@/lib/music/ytm-library";
import type { MusicCatalogRow as MusicCatalogRowData, MusicConnection } from "@/lib/music/types";
import { resolvedTitle, type MusicBand, type MusicBandContext } from "./music-band-types";

function anyConnected(connections: MusicConnection[]): boolean {
  return connections.some((row) => row.status === "connected");
}

function homeBand(
  ctx: MusicBandContext,
  key: string,
  row: MusicCatalogRowData | undefined,
  fallbackTitleKey: string,
  fallbackSubtitleKey: string,
): MusicBand {
  const t = ctx.t;
  const base: MusicCatalogRowData = row ?? {
    id: key,
    title: t(fallbackTitleKey),
    titleLiteral: true,
    subtitle: t(fallbackSubtitleKey),
    layout: "covers",
    source: "",
    items: [],
  };
  const resolved = row
    ? resolvedTitle(row, t)
    : { title: base.title, subtitle: base.subtitle ?? "" };
  const status = row ? ("ready" as const) : ctx.data.homeStatus;
  const openFullList = ytmLikedPlaylist(row, resolved.title);
  const openYtLibrary = row?.id === "ytm:home:playlists";

  return {
    key,
    title: resolved.title,
    catalog: true,
    render: (title) => (
      <MusicCatalogRow
        row={{ ...base, title, titleLiteral: true, subtitle: resolved.subtitle }}
        status={status}
        error={ctx.data.homeError}
        onRetry={ctx.data.reload}
        onOpen={(item) => ctx.openItem(item, base.items)}
        onViewAll={
          openFullList
            ? () => ctx.openItem(openFullList, base.items)
            : openYtLibrary
              ? () => ctx.openLibrary({ view: "youtube" })
              : undefined
        }
        playable
      />
    ),
  };
}

function connectBand(
  ctx: MusicBandContext,
  key: string,
  titleKey: string,
  sourceId: string,
  sourceName: string,
  body: string,
  connection: MusicConnection | undefined,
): MusicBand {
  return {
    key,
    title: ctx.t(titleKey),
    catalog: true,
    render: () => (
      <MusicConnectCard
        sourceId={sourceId}
        sourceName={connection?.name ?? sourceName}
        body={body}
        connection={connection ?? null}
      />
    ),
  };
}

/** The YouTube Music provider rows, rendered as their own section instead of page leftovers. */
export const YT_MUSIC_SOURCE = "youtube";

export function catalogRowBand(ctx: MusicBandContext, row: MusicCatalogRowData): MusicBand {
  return homeBand(ctx, `home:${row.id}`, row, "music.row.newReleases", "music.rail.newSubtitle");
}

/**
 * Every YouTube Music shelf in one section, in the provider's own order — liked songs, the
 * account's playlists, mixes, and the video chart. The rows are read from the home rows rather
 * than the classified slots so a shelf keeps its provider grouping wherever it would classify.
 */
export function ytMusicBands(
  ctx: MusicBandContext,
  rows: readonly MusicCatalogRowData[],
): MusicBand[] {
  return rows
    .filter((row) => row.source === YT_MUSIC_SOURCE && row.items.length > 0)
    .map((row) => catalogRowBand(ctx, row));
}

export function catalogBands(ctx: MusicBandContext): {
  newReleases: MusicBand;
  charts: MusicBand | null;
  stations: MusicBand[];
  extras: MusicBand[];
  scrobble: MusicBand | null;
  server: MusicBand[];
} {
  const { slots, connections, data } = ctx;
  const pending = data.homeStatus !== "ready";
  const open = pending || ctx.connectionsStatus !== "ready" || anyConnected(connections);
  const spare: MusicCatalogRowData[] = [];

  const newReleases = homeBand(
    ctx,
    "new-releases",
    slots.newReleases[0],
    "music.row.newReleases",
    "music.rail.newSubtitle",
  );
  spare.push(...slots.newReleases.slice(1));

  let charts: MusicBand | null = null;
  if (!ctx.chartsInFresh) {
    const row = slots.charts[0];
    if (row || open) {
      charts = homeBand(ctx, "charts", row, "music.row.charts", "music.row.chartsSubtitle");
    }
    spare.push(...slots.charts.slice(1));
  } else {
    spare.push(...slots.charts.slice(1));
  }

  const stations: MusicBand[] =
    slots.stations.length > 0
      ? slots.stations.map((row) =>
          homeBand(
            ctx,
            `station:${row.id}`,
            row,
            "music.row.stations",
            "music.row.stationsSubtitle",
          ),
        )
      : open
        ? [homeBand(ctx, "stations", undefined, "music.row.stations", "music.row.stationsSubtitle")]
        : [];

  // Provider rows (Spotify, YouTube Music) never reach the extras tail: they render in their own
  // sections, so the tail only carries catalog leftovers.
  const extras = [...spare, ...slots.extra].map((row) => catalogRowBand(ctx, row));

  const scrobbleConnection = connections.find((row) => row.kind === "scrobbler");
  const scrobbleRow = slots.scrobble[0];
  let scrobble: MusicBand | null = null;
  if (scrobbleRow) {
    scrobble = homeBand(
      ctx,
      "scrobble",
      scrobbleRow,
      "music.rail.basedOnHistory",
      "music.rail.basedOnHistory",
    );
  } else if (data.lastfm && !data.lastfm.connected) {
    scrobble = connectBand(
      ctx,
      "scrobble",
      "music.rail.basedOnHistory",
      scrobbleConnection?.id ?? "lastfm",
      "Last.fm",
      ctx.t("music.connect.scrobbleBody"),
      scrobbleConnection,
    );
  } else if (pending || data.lastfm?.connected) {
    scrobble = homeBand(
      ctx,
      "scrobble",
      undefined,
      "music.rail.basedOnHistory",
      "music.rail.basedOnHistory",
    );
  }

  const serverConnection = connections.find((row) => row.kind === "server" || row.kind === "local");
  const serverConnected = connections.some(
    (row) => (row.kind === "server" || row.kind === "local") && row.status === "connected",
  );
  const server: MusicBand[] =
    slots.server.length > 0
      ? slots.server.map((row) =>
          homeBand(ctx, `server:${row.id}`, row, "music.row.server", "music.row.serverSubtitle"),
        )
      : serverConnected || pending
        ? [homeBand(ctx, "server", undefined, "music.row.server", "music.row.serverSubtitle")]
        : [
            connectBand(
              ctx,
              "server",
              "music.row.server",
              serverConnection?.id ?? "local",
              ctx.t("music.connect.serverName"),
              ctx.t("music.connect.serverBody"),
              serverConnection,
            ),
          ];

  return { newReleases, charts, stations, extras, scrobble, server };
}
