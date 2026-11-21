import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

export function Synopsis({ text, stableHeight = false }: { text: string; stableHeight?: boolean }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [showToggle, setShowToggle] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (stableHeight) return;
    setExpanded(false);
    setShowToggle(false);
  }, [text, stableHeight]);

  const scrollable = stableHeight && expanded;
  useEffect(() => {
    if (scrollable && ref.current) ref.current.scrollTop = 0;
  }, [text, scrollable]);

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    // The first resize notification arrives after layout, including when the
    // text changes but still fills the same number of visible lines.
    const ro = new ResizeObserver(() => {
      const overflows = el.scrollHeight > el.clientHeight + 1;
      if (stableHeight || overflows) setShowToggle(overflows);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded, stableHeight]);

  // Reserve four lines and the button space for text that changes in place.
  const viewport = stableHeight
    ? scrollable
      ? "h-[clamp(4lh,34vh,8lh)] overflow-y-auto [scrollbar-gutter:stable]"
      : "h-[4lh]"
    : "";
  const toggle = (showToggle || expanded) && (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((e) => !e)}
      className={`inline-flex items-center gap-1 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink ${stableHeight ? "leading-5" : "mt-3"}`}
    >
      {expanded ? t("Show less") : t("Show more")}
      <ChevronDown
        className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
      />
    </button>
  );

  return (
    <div className="max-w-3xl">
      <p
        ref={ref}
        data-tauri-drag-region="false"
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? "region" : undefined}
        aria-label={scrollable ? t("Overview") : undefined}
        className={`text-[16px] leading-relaxed text-ink-muted ${expanded ? "" : "line-clamp-4"} ${viewport}`}
      >
        {text}
      </p>
      {stableHeight ? <div className="mt-3 h-5">{toggle}</div> : toggle}
    </div>
  );
}
