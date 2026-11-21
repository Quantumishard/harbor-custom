import { useState } from "react";
import { LoaderCircle } from "@/components/icons/music-icons";
import { useT } from "@/lib/i18n";
import { connectSource, disconnectSource } from "@/lib/music/catalog";
import { openYouTubeMusic } from "@/lib/music/ytmusic";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "./buttons";

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * YouTube Music needs no account to browse, so it is not connected in the usual sense: the
 * listener signs in inside the YouTube Music window and this borrows that session. The panel
 * only appears once the source's terms are accepted.
 */
export function YouTubeMusicAccount({
  account,
  onRefresh,
}: {
  account: string | null;
  onRefresh: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<"open" | "connect" | "signout" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const open = () => {
    setBusy("open");
    setFailure(null);
    void openYouTubeMusic()
      .catch((reason) => setFailure(errorText(reason)))
      .finally(() => setBusy(null));
  };

  const useSession = () => {
    setBusy("connect");
    setFailure(null);
    void connectSource("youtube")
      .then(() => {
        onRefresh();
        window.dispatchEvent(new Event("harbor:music-library-changed"));
      })
      .catch((reason) => setFailure(errorText(reason)))
      .finally(() => setBusy(null));
  };

  const signOut = () => {
    setBusy("signout");
    setFailure(null);
    void disconnectSource("youtube")
      .then(() => window.dispatchEvent(new Event("harbor:music-library-changed")))
      .catch((reason) => setFailure(errorText(reason)))
      .finally(() => {
        setBusy(null);
        onRefresh();
      });
  };

  return (
    <div className="border-t border-edge-soft bg-elevated/25 px-5 py-4">
      <p className="max-w-2xl text-[13px] leading-5 text-ink-muted">
        {account
          ? t("music.youtubeAccount.signedIn", { account })
          : t("music.youtubeAccount.intro")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={open} disabled={busy !== null} className={SECONDARY_BUTTON}>
          {busy === "open" && <LoaderCircle size={20} className="animate-spin" />}
          {t("music.youtubeAccount.open")}
        </button>
        {account ? (
          <button
            type="button"
            onClick={signOut}
            disabled={busy !== null}
            className={SECONDARY_BUTTON}
          >
            {busy === "signout" && <LoaderCircle size={20} className="animate-spin" />}
            {t("music.youtubeAccount.signOut")}
          </button>
        ) : (
          <button
            type="button"
            onClick={useSession}
            disabled={busy !== null}
            className={PRIMARY_BUTTON}
          >
            {busy === "connect" && <LoaderCircle size={20} className="animate-spin" />}
            {busy === "connect"
              ? t("music.youtubeAccount.checking")
              : t("music.youtubeAccount.use")}
          </button>
        )}
      </div>
      {failure ? (
        <p role="alert" className="mt-2 text-[12.5px] leading-5 text-danger">
          {failure}
        </p>
      ) : (
        <p className="mt-2 text-[12.5px] leading-5 text-ink-subtle">
          {account ? t("music.youtubeAccount.sessionNote") : t("music.youtubeAccount.hint")}
        </p>
      )}
    </div>
  );
}
