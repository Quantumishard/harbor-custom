import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "@/components/icons/music-icons";
import { useT } from "@/lib/i18n";
import { loadConnectorLibrary } from "@/lib/music/catalog";
import { ytmLikedPlaylist } from "@/lib/music/ytm-library";
import type { MusicCatalogItem, MusicCatalogRow as MusicCatalogRowData } from "@/lib/music/types";
import { MusicCatalogRow } from "./music-catalog-row";
import { MusicConnectCard } from "./music-connect-card";
import { useMusicConnections } from "./music-connections";

type FeedStatus = "idle" | "loading" | "ready" | "error";

/**
 * YouTube Music's own library: the account's playlists, liked songs and artists as grouped rows,
 * instead of spreading the same shelves across Home. Anonymous listeners cannot have a library,
 * so they get the connect shelf instead.
 */
export function MusicYtMusicLibrary({
  active = true,
  onOpen,
}: {
  active?: boolean;
  onOpen: (item: MusicCatalogItem, siblings: MusicCatalogItem[]) => void;
}) {
  const t = useT();
  const { connections, status: connectionsStatus } = useMusicConnections();
  const account = connections.find((connection) => connection.id === "youtube");
  const signedIn = Boolean(account?.account);
  const [rows, setRows] = useState<MusicCatalogRowData[]>([]);
  const [status, setStatus] = useState<FeedStatus>("idle");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!signedIn || !active) return;
    const run = ++generation.current;
    setStatus("loading");
    setError("");
    loadConnectorLibrary("youtube")
      .then((next) => {
        if (run !== generation.current) return;
        setRows(next);
        setStatus("ready");
      })
      .catch((cause) => {
        if (run !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });
    return () => {
      generation.current += 1;
    };
  }, [signedIn, active, reloadKey]);

  if (!signedIn) {
    if (connectionsStatus === "loading") {
      return (
        <div
          role="status"
          className="flex min-h-[160px] items-center justify-center gap-3 text-sm text-ink-muted"
        >
          <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" />
          {t("music.loading")}
        </div>
      );
    }
    return (
      <MusicConnectCard
        sourceId="youtube"
        sourceName="YouTube Music"
        body={t("music.ytLibrary.notSignedIn")}
        connection={account ?? null}
      />
    );
  }

  return (
    <section aria-label={t("music.ytLibrary.title")} className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-muted">
          {account?.account
            ? t("music.youtubeAccount.signedIn", { account: account.account })
            : t("music.ytLibrary.title")}
        </p>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={status === "loading"}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-edge px-3 text-[12px] font-medium text-ink transition-colors duration-200 ease-out hover:bg-elevated disabled:opacity-40"
        >
          {status === "loading" ? (
            <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw size={16} />
          )}
          {t("music.row.tryAgain")}
        </button>
      </header>

      {status === "error" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-edge-soft bg-surface px-6 py-5">
          <p role="alert" className="text-[13px] leading-5 text-ink-muted">
            {error || t("music.ytLibrary.empty")}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            className="w-fit rounded-md bg-elevated px-4 py-2 text-[13px] text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : status === "loading" && rows.length === 0 ? (
        <div
          role="status"
          className="flex min-h-[160px] items-center justify-center gap-3 text-sm text-ink-muted"
        >
          <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" />
          {t("music.loading")}
        </div>
      ) : (
        rows.map((row) => {
          const fullList = ytmLikedPlaylist(row, row.title);
          return (
            <MusicCatalogRow
              key={row.id}
              row={row}
              status="ready"
              onOpen={(item) => onOpen(item, row.items)}
              onViewAll={fullList ? () => onOpen(fullList, row.items) : undefined}
              playable
            />
          );
        })
      )}
    </section>
  );
}
