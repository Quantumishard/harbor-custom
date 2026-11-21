import { useEffect, type RefObject } from "react";

const EASE_MS = 55;
const MULTIPLIER = 1;
const SETTLE_PX = 0.5;

function scrollableAncestorBefore(from: EventTarget | null, stop: HTMLElement): boolean {
  let node = from instanceof Element ? from : null;
  while (node && node !== stop) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1)
      return true;
    node = node.parentElement;
  }
  return false;
}

export function useSmoothWheel(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Keep geometry reads out of the animation. Resize notifications keep the range
    // current as catalog sections fill, and a new gesture reads the native position.
    let maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    let pos = el.scrollTop;
    let target = pos;
    let raf = 0;
    let lastFrame = 0;

    const measure = () => {
      maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      pos = Math.min(pos, maxScroll);
      target = Math.min(target, maxScroll);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let children = new Set<Element>();
    const observeChildren = () => {
      const next = new Set(el.children);
      for (const child of children) {
        if (!next.has(child)) ro.unobserve(child);
      }
      for (const child of next) {
        if (!children.has(child)) ro.observe(child);
      }
      children = next;
    };
    observeChildren();
    const mo = new MutationObserver(() => {
      observeChildren();
      measure();
    });
    mo.observe(el, { childList: true });

    const step = (time: number) => {
      const diff = target - pos;
      if (Math.abs(diff) < SETTLE_PX) {
        pos = target;
        el.scrollTop = target;
        raf = 0;
        return;
      }
      // Time-based easing stays consistent when moving between 60/120/144Hz screens.
      const elapsed = Math.max(0, time - lastFrame);
      lastFrame = time;
      const amount = 1 - Math.exp(-elapsed / EASE_MS);
      pos += diff * amount;
      el.scrollTop = pos;
      raf = requestAnimationFrame(step);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || !e.cancelable || reducedMotion.matches) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.deltaMode !== 0) return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (scrollableAncestorBefore(e.target, el)) return;
      if (!raf) {
        measure();
        pos = Math.max(0, Math.min(maxScroll, el.scrollTop));
      }
      if (maxScroll <= 0) return;
      // Reverse immediately when the input changes direction.
      const continuing = raf && Math.sign(target - pos) === Math.sign(e.deltaY);
      const next = Math.max(
        0,
        Math.min(maxScroll, (continuing ? target : pos) + e.deltaY * MULTIPLIER),
      );
      if (!raf && next === pos) return;
      target = next;
      e.preventDefault();
      if (!raf) {
        lastFrame = performance.now();
        raf = requestAnimationFrame(step);
      }
    };

    const cancel = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", cancel, { passive: true, capture: true });
    el.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", cancel, { capture: true });
    reducedMotion.addEventListener("change", cancel);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", cancel, true);
      el.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", cancel, true);
      reducedMotion.removeEventListener("change", cancel);
      ro.disconnect();
      mo.disconnect();
      cancel();
    };
  }, [ref, enabled]);
}
