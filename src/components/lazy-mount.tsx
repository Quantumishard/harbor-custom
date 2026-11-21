import {
  startTransition,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { observeWithin } from "@/lib/visibility";
import { resolveRowScrollRoot, ScrollRootContext } from "./row";

const CULL_PAD_Y = 24;

const CULL_STYLE: CSSProperties = {
  contentVisibility: "auto",
  paddingLeft: "48px",
  paddingRight: "48px",
  marginLeft: "-48px",
  marginRight: "-48px",
  paddingTop: `${CULL_PAD_Y}px`,
  paddingBottom: `${CULL_PAD_Y}px`,
  marginTop: `-${CULL_PAD_Y}px`,
  marginBottom: `-${CULL_PAD_Y}px`,
};

export function LazyMount({
  children,
  fallback,
  rootMargin = "1200px 0px",
  minHeight = 240,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  rootMargin?: string;
  minHeight?: number;
}) {
  const pageScrollRoot = useContext(ScrollRootContext);
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    return observeWithin(
      el,
      rootMargin,
      (entry) => {
        if (entry.isIntersecting) startTransition(() => setShown(true));
      },
      resolveRowScrollRoot(pageScrollRoot, el),
    );
  }, [shown, rootMargin, pageScrollRoot]);

  return (
    <div
      ref={ref}
      className="harbor-lazy-cull"
      style={
        {
          ...CULL_STYLE,
          "--harbor-cull-min": `${minHeight}px`,
          ...(shown ? null : { minHeight: minHeight + CULL_PAD_Y * 2 }),
        } as CSSProperties
      }
      aria-hidden={shown ? undefined : true}
    >
      {shown ? children : fallback}
    </div>
  );
}
