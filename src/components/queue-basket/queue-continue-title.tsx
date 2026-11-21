import { type CSSProperties, useEffect, useRef, useState } from "react";

const GAP_PX = 24;
const PIXELS_PER_SECOND = 28;
const MIN_DURATION_MS = 6_000;

export function QueueContinueTitle({ text }: { text: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const copyRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const line = lineRef.current;
    const copy = copyRef.current;
    if (!viewport || !line || !copy) return;

    const measure = () => {
      const viewportWidth = viewport.clientWidth;
      const textWidth = copy.scrollWidth;

      if (viewportWidth <= 0 || textWidth <= viewportWidth + 1) {
        setDistance(0);
        return;
      }

      const direction = window.getComputedStyle(line).direction;
      const travel = textWidth + GAP_PX;
      setDistance(direction === "rtl" ? travel : -travel);
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(copy);

    return () => observer.disconnect();
  }, [text]);

  const durationMs =
    distance === 0
      ? 0
      : Math.max(MIN_DURATION_MS, Math.round((Math.abs(distance) / PIXELS_PER_SECOND) * 1_000));

  const style =
    distance === 0
      ? undefined
      : ({
          "--queue-title-distance": `${distance}px`,
          "--queue-title-duration": `${durationMs}ms`,
          "--queue-title-gap": `${GAP_PX}px`,
        } as CSSProperties);

  return (
    <span ref={viewportRef} className="queue-continue-card__title" title={text}>
      <span
        ref={lineRef}
        dir="auto"
        className="queue-continue-card__title-line"
        data-scrolling={distance !== 0 || undefined}
        style={style}
      >
        <span ref={copyRef} className="queue-continue-card__title-copy">
          {text}
        </span>

        {distance !== 0 && (
          <span
            aria-hidden="true"
            className="queue-continue-card__title-copy queue-continue-card__title-copy--duplicate"
          >
            {text}
          </span>
        )}
      </span>
    </span>
  );
}
