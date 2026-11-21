import { useCallback, useEffect, useState } from "react";

import {
  clearIdentityData,
  ensureIdentityPack,
  identityStatus,
  setIdentityFlags,
  type IdentityStatus,
} from "@/lib/identity";
import { useT } from "@/lib/i18n";
import { SettingRow } from "../kit";

function sizeLabel(bytes: number): string {
  if (!bytes) return "0 MB";
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Status and maintenance controls for the experimental local identity pack.
 * The toggle itself lives in the parent setting group; this row appears only
 * when the feature is enabled.
 */
export function AnimeIdentityStatus({ enabled }: { enabled: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setIdentityFlags({ pack: enabled, cards: enabled });
    if (!enabled) {
      setStatus(null);
      return;
    }
    setStatus(await identityStatus());
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!enabled) return null;

  const ready = status?.ready === true;
  const detail = ready
    ? [
        status?.packVersion ?? t("pack"),
        sizeLabel(status?.dbBytes ?? 0),
        `${status?.entries ?? 0} ${t("works")}`,
        status?.windows ? `${status.windows} ${t("windows")}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t("Not downloaded yet");

  const check = async () => {
    setBusy(true);
    try {
      setStatus(await ensureIdentityPack(true));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      setStatus(await clearIdentityData());
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label={t("Anime identity data")} desc={detail}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void check()}
          className="h-8 rounded-md border border-edge-soft/60 bg-canvas/70 px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
        >
          {busy ? t("Working…") : t("Check now")}
        </button>
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => void remove()}
          className="h-8 rounded-md border border-edge-soft/60 px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          {t("Delete local data")}
        </button>
      </div>
    </SettingRow>
  );
}
