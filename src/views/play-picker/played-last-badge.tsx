import { History } from "lucide-react";
import { useT } from "@/lib/i18n";

export function PlayedLastBadge() {
  const t = useT();
  return (
    <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] font-bold leading-none text-canvas">
      <History aria-hidden size={14} />
      {t("Played last")}
    </span>
  );
}
